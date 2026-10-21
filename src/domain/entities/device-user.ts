import type { EmploymentStatus } from './employee.js';

export interface DeviceUser {
  id: string; deviceId: string; userId: string; uid?: number; name?: string; role?: number; cardNumber?: string;
  rawData: Record<string, unknown>; syncedAt: Date; hasPhoto: boolean; employeeNumber?: string; employeeName?: string;
  employeePosition?: string; employeeBranchCode?: string; employeeStatus?: EmploymentStatus; employeeId?: string;
  branchId?: string; branchName?: string; displayName?: string; firstName?: string; lastName?: string; rfc?: string;
  socialSecurityNumber?: string;
}
export interface DeviceUserPhoto {
  deviceId: string; userId: string; contentType: 'image/jpeg'; imageData: Buffer; updatedAt: Date;
}
