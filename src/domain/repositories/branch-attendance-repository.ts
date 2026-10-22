import type { BranchAttendanceCards, BranchAttendanceFilters, BranchAttendanceQuery } from '../entities/branch-attendance.js';
import type { Employee } from '../entities/employee.js';
import type { EmployeeAttendanceHistory } from './employee-attendance-repository.js';

export interface BranchAttendanceSnapshot {
  branch: BranchAttendanceCards['branch']; employees: Employee[];
  histories: Map<string, EmployeeAttendanceHistory>; page: number; totalEmployees: number;
}
export interface BranchAttendanceRepository {
  snapshot(query: BranchAttendanceQuery): Promise<BranchAttendanceSnapshot>;
  exportSnapshot(filters: BranchAttendanceFilters): Promise<BranchAttendanceSnapshot>;
}
