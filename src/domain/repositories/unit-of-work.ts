import type { EmployeeRepository } from './employee-repository.js';

export interface TransactionRepositories { employees: EmployeeRepository }
export interface UnitOfWork {
  execute<T>(operation: (repositories: TransactionRepositories) => Promise<T>): Promise<T>;
}
