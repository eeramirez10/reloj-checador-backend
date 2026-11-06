import type { LeaveProfileInput } from '../entities/leave.js';
import type { LeaveSession } from '../repositories/leave-repository.js';
import { ConfigurationError, ConflictError } from '../errors/app-error.js';

export type EmployeeLeaveProfileSession = Pick<LeaveSession, 'context' | 'profile' | 'saveProfile' | 'vacationMovement'>;

export function requireActiveEmployee(employee: { isActive: boolean; identificationStatus: string }): void {
  if (!employee.isActive || employee.identificationStatus !== 'confirmed') throw new ConfigurationError('Selecciona un empleado activo e identificado.');
}

export async function saveEmployeeLeaveProfile(session: EmployeeLeaveProfileSession, employeeId: string, input: LeaveProfileInput) {
  const employee = (await session.context(employeeId, '2000-01-01', '2000-01-01')).employee;
  if (employee.identificationStatus !== 'confirmed') throw new ConfigurationError('Identifica al empleado antes de configurar permisos.');
  const current = await session.profile(employeeId);
  if (current.version !== input.expectedVersion) throw new ConflictError('La configuración o el saldo cambió. Actualiza la ficha antes de guardar.');
  const visited = new Set([employeeId]);
  let managerId = input.managerId;
  while (managerId) {
    if (visited.has(managerId)) throw new ConfigurationError('La asignación de jefe generaría un ciclo en la jerarquía.');
    visited.add(managerId);
    const manager = (await session.context(managerId, '2000-01-01', '2000-01-01')).employee;
    requireActiveEmployee(manager);
    managerId = (await session.profile(managerId)).managerId;
  }
  const adjustment = input.vacationBalance - current.vacationBalance;
  if (adjustment && !input.adjustmentReason.trim()) throw new ConfigurationError('Escribe el motivo del ajuste de vacaciones.');
  await session.saveProfile(employeeId, { ...input, vacationBalance: current.vacationBalance });
  if (adjustment) await session.vacationMovement(employeeId, adjustment, 'adjustment', input.adjustmentReason);
  return session.profile(employeeId);
}
