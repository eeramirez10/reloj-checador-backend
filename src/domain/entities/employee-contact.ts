export interface EmployeeContact {
  employeeId: string; email: string | null; alternatePhone: string | null; bloodType: string | null;
  whatsappPhone: string | null; version: number;
}
export interface ContactInput {
  email?: string | null; alternatePhone: string | null; bloodType: string | null;
  whatsappPhone: string | null; expectedVersion: number;
}
