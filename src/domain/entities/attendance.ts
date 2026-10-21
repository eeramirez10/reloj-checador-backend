import type { EmploymentStatus } from './employee.js';

export interface AttendanceLog {
  id: string; deviceId: string; deviceLogId?: string; userId: string; verificationType?: number;
  userName?: string; userHasPhoto: boolean; employeeNumber?: string; employeePosition?: string;
  employeeBranchCode?: string; employeeStatus?: EmploymentStatus; punchState?: number;
  occurredAt: Date; rawData: unknown; receivedAt: Date; branchId?: string; branchName?: string; employeeId?: string;
}
