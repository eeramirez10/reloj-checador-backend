import type { UnitOfWork } from '../repositories/unit-of-work.js';
import { validateEmployeeScheduling, type EmployeeScheduleInput } from '../entities/employee-scheduling.js';
import type { LeaveProfileInput } from '../entities/leave.js';
import { saveEmployeeLeaveProfile } from './save-employee-leave-profile.js';
import type { ContactInput } from '../entities/employee-contact.js';
import { ConfigurationError } from '../errors/app-error.js';

export class UpdateEmployee {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(id: string, fields: Record<string, string | null>, isActive?: boolean, scheduling?: EmployeeScheduleInput, leaveProfile?: LeaveProfileInput, contact?: ContactInput): Promise<boolean> {
    return this.unitOfWork.execute(async ({ employees, employeeScheduling, employeeLeave, employeeContacts }) => {
      if (scheduling) {
        await employeeScheduling.lock(id);
        const context = await employeeScheduling.context(id, scheduling.effectiveFrom);
        validateEmployeeScheduling(scheduling, context.baseSchedule);
      }
      const hasProfileChanges = Object.keys(fields).length > 0 || isActive !== undefined;
      const updated = hasProfileChanges ? await employees.update(id, fields, isActive) : false;
      if (hasProfileChanges && !updated) return false;
      if (scheduling) await employeeScheduling.append(id, scheduling);
      if (leaveProfile) await saveEmployeeLeaveProfile(employeeLeave, id, leaveProfile);
      if (contact) {
        if (!employeeContacts) throw new ConfigurationError('Falta configurar el repositorio de contacto.');
        await employeeContacts.save(id,contact);
      }
      return updated || Boolean(scheduling) || Boolean(leaveProfile) || Boolean(contact);
    });
  }
}
