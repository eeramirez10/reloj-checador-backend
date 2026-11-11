import type { EmploymentStatus } from '../entities/employee.js';

export interface AttendanceFilters { deviceId?: string; branchId?: string; userId?: string; from?: Date; to?: Date; limit: number }
export interface EmployeeFilters {
  sortBy?:'name'|'branch'|'company';sortOrder?:'asc'|'desc';
  branchId?: string; companyId?: string;
  search?: string; branchCode?: string; employmentStatus?: EmploymentStatus;
  identificationStatus?: 'confirmed' | 'pending'; limit: number;
}
export interface ReportFilters { from: string; to: string; branchId?: string; subjectId?: string; companyId?: string }
