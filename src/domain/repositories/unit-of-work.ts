import type { EmployeeRepository } from './employee-repository.js';
import type { EmployeeSchedulingRepository } from './employee-scheduling-repository.js';

export interface TransactionRepositories { employees: EmployeeRepository; employeeScheduling: EmployeeSchedulingRepository }
export interface UnitOfWork {
  execute<T>(operation: (repositories: TransactionRepositories) => Promise<T>): Promise<T>;
}
