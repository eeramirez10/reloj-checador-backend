import { formatDateTimeInTimeZone } from '../entities/attendance-summary.js';
import { effectiveVersion, resolveEmployeeSchedule } from '../entities/employee-scheduling.js';
import { addDays, dateAtLocalTime } from '../entities/schedule-evaluator.js';
import type { AttendancePeriod, EmployeeAttendanceCard, EmployeeAttendanceDay, EmployeeAttendanceStatus, EmployeeAttendanceSummary } from '../entities/employee-attendance.js';
import type { Employee } from '../entities/employee.js';
import type { EmployeeAttendanceHistory, EmployeeAttendanceRepository } from '../repositories/employee-attendance-repository.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import { NotFoundError } from '../errors/not-found-error.js';
import { pendingOvertime } from '../entities/overtime.js';
import { authorizationsForDay, unauthorizedEarlyExit } from '../entities/leave-attendance.js';
import { latenessMinutes } from '../entities/tolerance.js';
import { isOffsiteWork } from '../entities/leave.js';

export function dayContext(date: string, employee: Employee, history: EmployeeAttendanceHistory) {
  const branchId = history.branchAssignments.length ? effectiveVersion(history.branchAssignments, date)?.branchId : employee.branchId;
  const branch = history.branches.find((item) => item.id === branchId);
  const base = effectiveVersion(history.schedules.filter((item) => item.branchId === branchId && item.isDefault), date);
  const assignment = effectiveVersion(history.assignments, date);
  const assigned = history.schedules.find((item) => item.id === assignment?.scheduleId && item.effectiveFrom <= date);
  const version = effectiveVersion(history.employeeSchedules, date);
  const useBranch = version?.overtime?.enabled;
  return { branch, version, schedule: useBranch ? base ? resolveEmployeeSchedule(base,undefined,version ? { ...version, workHours: null } : undefined) : undefined
    : resolveEmployeeSchedule(base, assigned, version) };
}

function emptyDayStatus(date: string, timeZone: string, settings: EmployeeAttendanceDay['scheduleSettings'], now: Date): EmployeeAttendanceStatus {
  if (!settings) return 'unconfigured';
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  if (!settings.workDays.includes(weekday)) return 'day_off';
  const today = formatDateTimeInTimeZone(now, timeZone).slice(0,10);
  if (date > today) return 'upcoming';
  const deadline = dateAtLocalTime(date, settings.exitTime, timeZone).getTime() + (settings.recognitionMarginMinutes ?? 30) * 60_000;
  return now.getTime() <= deadline ? 'in_progress' : 'no_records';
}

function buildDay(date: string, employee: Employee, history: EmployeeAttendanceHistory,
  evaluation: EmployeeAttendanceHistory['evaluations'][number] | undefined, now: Date): EmployeeAttendanceDay {
  const { branch, schedule, version } = dayContext(date, employee, history);
  const result = evaluation?.result;
  const authorizations = authorizationsForDay(history.approvedLeaves ?? [], date);
  const settings = result?.scheduleSettings ?? schedule?.settings ?? null;
  const timeZone = result?.timeZone ?? branch?.timeZone ?? 'America/Mexico_City';
  const status = authorizations.some(item=>isOffsiteWork(item.kind)) ? 'authorized_work' : authorizations.some((item) => item.kind === 'absence') && !result?.punches.length && !result?.routes?.length
    ? 'authorized_absence' : result?.status ?? emptyDayStatus(date, timeZone, settings, now);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  const workday = settings?.workDays.includes(weekday);
  const expectedEntry = settings ? dateAtLocalTime(date,settings.entryTime,timeZone).getTime() : null;
  const alreadyWorking = expectedEntry !== null && result?.routes?.some((route) => Date.parse(route.segmentStart) <= expectedEntry
    && (!route.segmentEnd || Date.parse(route.segmentEnd) > expectedEntry));
  const arrivalDelayMinutes = result?.entry && settings && workday
    ? alreadyWorking ? 0 : latenessMinutes(Date.parse(result.entry), expectedEntry!) : null;
  const earlyExitMinutes = result?.exit && settings && workday && !result.routes?.length
    ? Math.max(0, Math.ceil((dateAtLocalTime(date, settings.exitTime, timeZone).getTime() - Date.parse(result.exit)) / 60_000)) : null;
  const overtime = !version?.overtime?.enabled ? undefined : result?.overtime ?? pendingOvertime(result?.punches.length || status === 'unconfigured' ? 'pending' : 'no_records',
    result?.punches.length ? 'Actualiza el cálculo de esta jornada.' : status === 'unconfigured' ? 'Falta una jornada de sucursal vigente.' : 'No hay registros para calcular horas extras.');
  return {
    date, status, branchName: result?.branchName ?? branch?.name ?? null, timeZone,
    scheduleName: result?.scheduleName ?? schedule?.scheduleName ?? null, scheduleSettings: settings,
    entry: result?.entry ?? null, mealDeparture: result?.mealDeparture ?? null, mealReturn: result?.mealReturn ?? null,
    exit: result?.exit ?? null, mealMinutes: result?.mealMinutes ?? null, workedMinutes: result?.workedMinutes ?? null,
    overtime, routes: result?.routes,
    arrivalDelayMinutes, earlyExitMinutes, issues: result?.issues ?? [], missingMovements: result?.missingMovements ?? [],
    punches: result?.punches ?? [], incidents: result?.incidents ?? [],
    ...(authorizations.length ? { leaveAuthorizations: authorizations,
      unauthorizedEarlyExitMinutes: unauthorizedEarlyExit(date, result?.exit ?? null, settings, authorizations, timeZone) } : {}),
  };
}

function summarize(days: EmployeeAttendanceDay[]): EmployeeAttendanceSummary {
  const summary: EmployeeAttendanceSummary = { recordedDays: 0, completeDays: 0, incompleteDays: 0, daysWithoutRecords: 0,
    daysOff: 0, arrivalTardies: 0, mealTardies: 0, earlyExits: 0, workedMinutes: 0, calculableDays: 0 };
  for (const day of days) {
    if (day.punches.length || day.routes?.length) summary.recordedDays += 1;
    if (day.status === 'complete') summary.completeDays += 1;
    if (day.punches.length && ['incomplete','ambiguous','unconfigured'].includes(day.status)) summary.incompleteDays += 1;
    if (day.status === 'no_records') summary.daysWithoutRecords += 1;
    if (day.status === 'day_off') summary.daysOff += 1;
    if (day.status === 'authorized_absence') summary.authorizedAbsenceDays = (summary.authorizedAbsenceDays ?? 0) + 1;
    if (day.status === 'authorized_work') summary.authorizedWorkDays = (summary.authorizedWorkDays ?? 0) + 1;
    summary.arrivalTardies += day.incidents.filter((item) => item.kind === 'arrival').length;
    summary.mealTardies += day.incidents.filter((item) => item.kind !== 'arrival').length;
    if ((day.unauthorizedEarlyExitMinutes ?? day.earlyExitMinutes ?? 0) > 0) summary.earlyExits += 1;
    if (day.workedMinutes !== null) { summary.workedMinutes += day.workedMinutes; summary.calculableDays += 1; }
  }
  return summary;
}

export function buildEmployeeAttendanceCard(employee: Employee, history: EmployeeAttendanceHistory,
  period: AttendancePeriod, now = new Date()): EmployeeAttendanceCard {
  const evaluations = new Map(history.evaluations.map((day) => [day.date, day]));
  const days: EmployeeAttendanceDay[] = [];
  for (let date = period.from; date <= period.to; date = addDays(date, 1)) {
    days.push(buildDay(date, employee, history, evaluations.get(date), now));
    if (date === period.to) break;
  }
  return { employee, period, days, summary: summarize(days) };
}

export class GetEmployeeAttendance {
  constructor(private readonly employees: Pick<EmployeeRepository, 'findById'>, private readonly repository: EmployeeAttendanceRepository) {}

  async execute(employeeId: string, period: AttendancePeriod, now = new Date()): Promise<EmployeeAttendanceCard> {
    const employee = await this.employees.findById(employeeId);
    if (!employee) throw new NotFoundError('Empleado no encontrado.');
    const history = await this.repository.history(employeeId, period);
    return buildEmployeeAttendanceCard(employee, history, period, now);
  }
}
