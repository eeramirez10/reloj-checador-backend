import { ConfigurationError } from '../errors/app-error.js';
import { getUpdatedProfileName, type UserProfilePatch } from '../entities/personal-profile.js';
import { formatDateTimeInTimeZone } from '../entities/attendance-summary.js';
import type { EmployeeCreation, EmployeeIdentification, EmployeeRegistryRepository } from '../repositories/employee-registry-repository.js';

function personalFields(input: UserProfilePatch): Record<string, string | null> {
  return Object.fromEntries(Object.entries({ firstName: input.firstName, lastName: input.lastName, rfc: input.rfc, imss: input.socialSecurityNumber })
    .filter(([, value]) => value !== undefined)) as Record<string, string | null>;
}

export class EmployeeRegistry {
  constructor(private readonly repository: EmployeeRegistryRepository, private readonly now: () => Date = () => new Date()) {}

  async create(input: EmployeeCreation): Promise<string> {
    const name = getUpdatedProfileName({ firstName: null, lastName: null }, input);
    if (!name) throw new ConfigurationError('Completa Nombre(s) para crear al empleado.');
    return this.repository.transaction(async (session) => {
      const timeZone = await session.branchTimeZone(input.branchId);
      if (!timeZone) throw new ConfigurationError('Sucursal no encontrada.');
      return session.create(input, name, formatDateTimeInTimeZone(this.now(), timeZone).slice(0, 10));
    });
  }

  identify(id: string, input: EmployeeIdentification): Promise<string> {
    return this.repository.transaction(async (session) => {
      const source = await session.lockEmployee(id);
      if (source.identificationStatus === 'merged') throw new ConfigurationError('Esta ficha ya fue asociada a otro empleado.');
      if (!input.targetEmployeeId || input.targetEmployeeId === id) {
        const fields = personalFields(input);
        if (Object.keys(fields).length) await session.updateProfile(id, fields);
        const updated = await session.lockEmployee(id);
        if (!updated.firstName) throw new ConfigurationError('Completa Nombre(s) antes de confirmar la identificación.');
        await session.confirm(id);
        return id;
      }
      if (source.identificationStatus !== 'pending') throw new ConfigurationError('Solo las fichas pendientes pueden asociarse a un empleado existente.');
      if (Object.keys(personalFields(input)).length) throw new ConfigurationError('Guarda los datos personales en la ficha antes de asociarla.');
      const target = await session.lockEmployee(input.targetEmployeeId);
      if (target.identificationStatus !== 'confirmed') throw new ConfigurationError('Selecciona un empleado ya identificado.');
      if (source.branchId && target.branchId && source.branchId !== target.branchId) throw new ConfigurationError('El registro y el empleado deben pertenecer a la misma sucursal.');
      const sourceClock = (await session.listClocks(id))[0];
      const currentClock = await session.currentClock(target.id);
      if (sourceClock && (!currentClock || input.useAsAssignedClock) && (target.branchId ?? source.branchId) !== sourceClock.branchId) {
        throw new ConfigurationError('El reloj actual debe pertenecer a la sucursal del empleado.');
      }
      if (currentClock && sourceClock && currentClock.deviceId !== sourceClock.deviceId && !input.useAsAssignedClock) {
        throw new ConfigurationError('El empleado ya tiene otro reloj asignado. Selecciona usar este registro como su reloj actual.');
      }
      await session.archiveAndMerge(source.id, target.id);
      if (sourceClock && (!currentClock || input.useAsAssignedClock)) {
        await session.assignClock(target.id, sourceClock.id, currentClock?.id, 'identification');
      }
      await session.finishMerge(source.id, target.id);
      return target.id;
    });
  }

  async assignClock(employeeId: string, clockRecordId: string): Promise<void> {
    const ownerId = await this.repository.clockEmployeeId(clockRecordId);
    if (!ownerId) throw new ConfigurationError('Registro de reloj no encontrado. Sincroniza sus empleados primero.');
    if (ownerId !== employeeId) {
      await this.identify(ownerId, { targetEmployeeId: employeeId, useAsAssignedClock: true });
      return;
    }
    await this.repository.transaction(async (session) => {
      const employee = await session.lockEmployee(employeeId);
      const clock = await session.findClock(clockRecordId);
      if (!clock || clock.employeeId !== employeeId) throw new ConfigurationError('La asignación cambió; actualiza la página.');
      if (!employee.branchId || employee.branchId !== clock.branchId) throw new ConfigurationError('El reloj debe pertenecer a la sucursal del empleado.');
      const previous = await session.currentClock(employeeId);
      await session.assignClock(employeeId, clockRecordId, previous?.id, 'assignment');
    });
  }

  history(employeeId: string) { return this.repository.history(employeeId); }
}
