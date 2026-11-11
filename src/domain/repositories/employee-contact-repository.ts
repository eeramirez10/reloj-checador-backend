import type { ContactInput, EmployeeContact } from '../entities/employee-contact.js';
export interface EmployeeContactRepository {
  get(employeeId: string): Promise<EmployeeContact>;
  save(employeeId: string, input: ContactInput): Promise<EmployeeContact>;
}
