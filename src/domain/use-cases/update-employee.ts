import type { UnitOfWork } from '../repositories/unit-of-work.js';
import { validateEmployeeScheduling, type EmployeeScheduleInput } from '../entities/employee-scheduling.js';

export class UpdateEmployee {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(id: string, fields: Record<string, string | null>, isActive?: boolean, scheduling?: EmployeeScheduleInput): Promise<boolean> {
    return this.unitOfWork.execute(async ({ employees, employeeScheduling }) => {
      if (scheduling) {
        await employeeScheduling.lock(id);
        const context = await employeeScheduling.context(id, scheduling.effectiveFrom);
        validateEmployeeScheduling(scheduling, context.baseSchedule);
      }
      const hasProfileChanges = Object.keys(fields).length > 0 || isActive !== undefined;
      const updated = hasProfileChanges ? await employees.update(id, fields, isActive) : false;
      if (hasProfileChanges && !updated) return false;
      if (scheduling) await employeeScheduling.append(id, scheduling);
      return updated || Boolean(scheduling);
    });
  }
}
