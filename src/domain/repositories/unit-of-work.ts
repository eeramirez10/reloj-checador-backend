import type { EmployeeRepository } from './employee-repository.js';
import type { EmployeeSchedulingRepository } from './employee-scheduling-repository.js';
import type { LeaveSession } from './leave-repository.js';
import type { EmployeeContactRepository } from './employee-contact-repository.js';

export interface TransactionRepositories {
  employees: EmployeeRepository;
  employeeScheduling: EmployeeSchedulingRepository;
  employeeContacts?: EmployeeContactRepository;
  employeeLeave: Pick<LeaveSession, 'context' | 'profile' | 'saveProfile' | 'vacationMovement'>;
}
export interface UnitOfWork {
  execute<T>(operation: (repositories: TransactionRepositories) => Promise<T>): Promise<T>;
}
