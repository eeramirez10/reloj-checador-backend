import type { EmployeeRepository } from './employee-repository.js';
import type { EmployeeSchedulingRepository } from './employee-scheduling-repository.js';
import type { LeaveSession } from './leave-repository.js';

export interface TransactionRepositories {
  employees: EmployeeRepository;
  employeeScheduling: EmployeeSchedulingRepository;
  employeeLeave: Pick<LeaveSession, 'context' | 'profile' | 'saveProfile' | 'vacationMovement'>;
}
export interface UnitOfWork {
  execute<T>(operation: (repositories: TransactionRepositories) => Promise<T>): Promise<T>;
}
