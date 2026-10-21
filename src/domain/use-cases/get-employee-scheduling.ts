import type { EmployeeSchedulingRepository } from '../repositories/employee-scheduling-repository.js';
import { resolveEmployeeSchedule } from '../entities/employee-scheduling.js';

export class GetEmployeeScheduling {
  constructor(private readonly repository: EmployeeSchedulingRepository) {}

  async execute(employeeId: string, date?: string) {
    const context = await this.repository.context(employeeId, date);
    return { ...context, resolved: resolveEmployeeSchedule(context.baseSchedule, context.assignedSchedule, context.version) ?? null };
  }
}
