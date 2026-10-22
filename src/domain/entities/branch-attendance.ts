import type { AttendancePeriod, EmployeeAttendanceCard } from './employee-attendance.js';
import type { Branch } from './organization.js';

export interface BranchAttendanceFilters extends AttendancePeriod {
  branchId: string; employeeStatus: 'active' | 'inactive';
}
export interface BranchAttendanceQuery extends BranchAttendanceFilters { page: number; limit: number }
export interface BranchAttendanceExport {
  branch: Pick<Branch, 'id' | 'name' | 'timeZone'>;
  period: AttendancePeriod;
  employeeStatus: BranchAttendanceQuery['employeeStatus'];
  totalEmployees: number;
  cards: EmployeeAttendanceCard[];
}
export interface BranchAttendanceCards extends BranchAttendanceExport {
  page: number;
  pageSize: number;
  totalPages: number;
}
