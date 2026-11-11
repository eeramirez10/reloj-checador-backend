import type { EmployeeContact, ContactInput } from '../entities/employee-contact.js';
export interface PortalProfile {
  employeeId: string; name: string; employeeNumber: string | null; branchName: string | null;
  companyId?: string | null; companyName?: string | null;
  timeZone: string; managerName: string | null; vacationBalance: number; hasReports: boolean;
  contact: EmployeeContact;
}
export interface EmployeeAccessView {
  account: { id: string; username: string; role: string; isActive: boolean; mustChangePassword: boolean } | null;
  messages: { id: string; state: string; recipient: string; attempts: number; errorCode: string | null; createdAt: Date }[];
}
export interface EmployeePortalRepository {
  profile(employeeId: string): Promise<PortalProfile>;
  saveContact(employeeId: string, input: ContactInput, accountId: string): Promise<EmployeeContact>;
  managers(): Promise<{ id: string; name: string; branchName: string | null }[]>;
  bloodTypes(): Promise<string[]>;
  access(employeeId: string): Promise<EmployeeAccessView>;
}
