import type { EmployeeSchedulingDatasource } from '../../domain/datasources/employee-scheduling-datasource.js';
import type { EmployeeSchedulingRepository } from '../../domain/repositories/employee-scheduling-repository.js';
import type { EmployeeScheduleInput } from '../../domain/entities/employee-scheduling.js';

export class EmployeeSchedulingRepositoryImpl implements EmployeeSchedulingRepository {
  constructor(private readonly datasource: EmployeeSchedulingDatasource) {}
  lock(employeeId: string) { return this.datasource.lock(employeeId); }
  context(employeeId: string, date?: string) { return this.datasource.context(employeeId, date); }
  append(employeeId: string, input: EmployeeScheduleInput) { return this.datasource.append(employeeId, input); }
}
