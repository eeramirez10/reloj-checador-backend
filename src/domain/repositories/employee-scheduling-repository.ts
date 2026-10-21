import type { EmployeeScheduleInput, SchedulingContext } from '../entities/employee-scheduling.js';

export interface EmployeeSchedulingRepository {
  lock(employeeId: string): Promise<void>;
  context(employeeId: string, date?: string): Promise<SchedulingContext>;
  append(employeeId: string, input: EmployeeScheduleInput): Promise<void>;
}
