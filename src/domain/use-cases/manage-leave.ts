import { ConfigurationError, ConflictError } from '../errors/app-error.js';
import { addDays, dateAtLocalTime } from '../entities/local-date.js';
import type { LeaveDay, LeaveFilters, LeaveInput, LeavePreview, LeaveProfileInput, LeaveRequest } from '../entities/leave.js';
import type { LeaveRepository, LeaveSession } from '../repositories/leave-repository.js';
import { dayContext } from './get-employee-attendance.js';
import { requireActiveEmployee, saveEmployeeLeaveProfile } from './save-employee-leave-profile.js';

async function preview(session: LeaveSession, input: LeaveInput, fingerprint: (value: string) => string): Promise<LeavePreview> {
  const { employee, profile, history } = await session.context(input.employeeId, input.from, input.to);
  requireActiveEmployee(employee);
  if (!profile.managerId) throw new ConfigurationError('Asigna un jefe directo al empleado antes de solicitar un permiso.');
  const manager = (await session.context(profile.managerId, input.from, input.to)).employee;
  requireActiveEmployee(manager);
  if (input.useVacation && (input.kind !== 'absence' || !input.paid)) throw new ConfigurationError('Los días de vacaciones solo se usan para faltar con goce de sueldo.');
  if (employee.hireDate && input.from < employee.hireDate) throw new ConfigurationError('El permiso no puede comenzar antes de la fecha de alta.');
  const days: LeaveDay[] = [];
  for (let date = input.from; date <= input.to; date = addDays(date, 1)) {
    const { branch, schedule } = dayContext(date, employee, history);
    if (!branch || !schedule) throw new ConfigurationError(`Configura sucursal y jornada laboral para el ${date}.`);
    if (!schedule.settings.workDays.includes(new Date(`${date}T12:00:00Z`).getUTCDay() || 7)) continue;
    const { entryTime, exitTime } = schedule.settings;
    if (input.kind !== 'absence' && (!input.authorizedTime || input.authorizedTime <= entryTime || input.authorizedTime >= exitTime)) {
      throw new ConfigurationError(`La hora autorizada debe estar entre ${entryTime} y ${exitTime} para el ${date}.`);
    }
    const startTime = input.kind === 'early_exit' ? input.authorizedTime! : entryTime;
    const endTime = input.kind === 'late_arrival' ? input.authorizedTime! : exitTime;
    days.push({ date, branchId: branch.id, branchName: branch.name, timeZone: branch.timeZone,
      scheduledEntry: entryTime, scheduledExit: exitTime,
      start: dateAtLocalTime(date, startTime, branch.timeZone).toISOString(), end: dateAtLocalTime(date, endTime, branch.timeZone).toISOString() });
  }
  if (!days.length) throw new ConfigurationError('El rango seleccionado no incluye días laborables.');
  const overlapping = await session.overlapping(employee.id, input.from, input.to);
  if (overlapping.some((request) => request.details.days.some((other) => days.some((day) => day.start < other.end && other.start < day.end)))) {
    throw new ConflictError('Ya existe un permiso pendiente o aprobado que coincide con este periodo.');
  }
  const details = { employeeName: employee.name, employeeNumber: employee.employeeNumber ?? null, managerName: manager.name, branchName: days[0].branchName, days };
  const vacationDays = input.useVacation ? days.length : 0;
  const result = { input, managerId: manager.id, details, vacationBalance: profile.vacationBalance, vacationDays };
  return { ...result, token: fingerprint(JSON.stringify({ ...result, profileVersion: profile.version })) };
}

export class ManageLeave {
  constructor(private readonly repository: LeaveRepository, private readonly fingerprint: (value: string) => string) {}
  list(filters: LeaveFilters) { return this.repository.list(filters); }
  detail(id: string) { return this.repository.detail(id); }
  profile(id: string) { return this.repository.profile(id); }
  preview(input: LeaveInput) { return this.repository.transaction((session) => preview(session, input, this.fingerprint)); }

  saveProfile(employeeId: string, input: LeaveProfileInput) {
    return this.repository.transaction((session) => saveEmployeeLeaveProfile(session, employeeId, input));
  }

  create(input: LeaveInput, token: string, sourceKey: string) {
    return this.repository.transaction(async (session) => {
      const existing = await session.findBySourceKey(sourceKey);
      if (existing) {
        const same = (Object.keys(input) as Array<keyof LeaveInput>).every((key) => existing[key] === input[key]);
        if (!same) throw new ConflictError('Este identificador ya se utilizó con otra solicitud.');
        return existing;
      }
      const calculated = await preview(session, input, this.fingerprint);
      if (calculated.token !== token) throw new ConflictError('El horario, jefe o saldo cambió. Revisa nuevamente la solicitud.');
      if (calculated.vacationDays > calculated.vacationBalance) throw new ConfigurationError('El saldo de vacaciones es insuficiente para esta solicitud.');
      const request = await session.create(input, calculated.managerId, calculated.details.days[0].branchId, calculated.details, sourceKey);
      await session.event(request, 'created', input.reason);
      return request;
    });
  }

  resolve(id: string, input: { action: 'approve' | 'reject' | 'cancel'; expectedVersion: number; actorEmployeeId: string; comments: string }) {
    return this.repository.transaction(async (session) => {
      const request = await session.find(id);
      if (request.version !== input.expectedVersion) throw new ConflictError('La solicitud cambió. Actualiza su detalle.');
      const cancellation = input.action === 'cancel';
      if (cancellation ? !['pending', 'approved'].includes(request.status) : request.status !== 'pending') throw new ConflictError('La solicitud ya fue resuelta.');
      const allowedActors = cancellation ? [request.employeeId, request.managerId] : [request.managerId];
      if (!allowedActors.includes(input.actorEmployeeId)) throw new ConfigurationError('La resolución debe registrarse a nombre del jefe responsable; el empleado también puede cancelar.');
      const actor = (await session.context(input.actorEmployeeId, request.from, request.to)).employee;
      requireActiveEmployee(actor);
      if (input.action !== 'approve' && !input.comments.trim()) throw new ConfigurationError('Escribe el motivo de rechazo o cancelación.');
      if (input.action === 'approve') await this.validateApproval(session, request);
      const vacationDays = request.useVacation ? request.details.days.length : 0;
      if (vacationDays && input.action === 'approve') await session.vacationMovement(request.employeeId, -vacationDays, 'consumption', 'Permiso aprobado a cuenta de vacaciones.', request.id);
      if (vacationDays && cancellation && request.status === 'approved') await session.vacationMovement(request.employeeId, vacationDays, 'return', input.comments, request.id);
      const status = input.action === 'approve' ? 'approved' : input.action === 'reject' ? 'rejected' : 'cancelled';
      const updated = await session.resolve(id, status, input.actorEmployeeId);
      await session.event(updated, status, input.comments, input.actorEmployeeId);
      if (status === 'approved' || request.status === 'approved') await session.recalculateAttendance();
      return updated;
    });
  }

  private async validateApproval(session: LeaveSession, request: LeaveRequest) {
    const { employee, profile, history } = await session.context(request.employeeId, request.from, request.to);
    requireActiveEmployee(employee);
    if (request.useVacation && profile.vacationBalance < request.details.days.length) throw new ConflictError('El saldo de vacaciones ya no es suficiente.');
    for (let date = request.from; date <= request.to; date = addDays(date, 1)) {
      const day = request.details.days.find((item) => item.date === date);
      const { branch, schedule } = dayContext(date, employee, history);
      const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
      if (!day && schedule && !schedule.settings.workDays.includes(weekday)) continue;
      if (!day) throw new ConflictError('Los días laborables cambiaron. Cancela la solicitud y registra una nueva.');
      if (branch?.id !== day.branchId || branch.timeZone !== day.timeZone || schedule?.settings.entryTime !== day.scheduledEntry
        || schedule.settings.exitTime !== day.scheduledExit || !schedule.settings.workDays.includes(weekday)) {
        throw new ConflictError('El horario o sucursal cambió desde la solicitud. Cancélala y registra una nueva con las fechas vigentes.');
      }
    }
  }
}
