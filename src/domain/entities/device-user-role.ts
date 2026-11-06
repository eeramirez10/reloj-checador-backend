import type { Device } from './device.js';

export type WritableDeviceUserRole = 0 | 14;
export interface DeviceUserRoleTarget { userId: string; uid: number }
export interface DeviceUserRoleSnapshot extends DeviceUserRoleTarget {
  role: number; administratorCount: number; totalUsers: number; measuredAt: string;
}
export interface DeviceUserRoleInput extends DeviceUserRoleTarget { expectedRole: number; role: WritableDeviceUserRole }
export interface DeviceUserRoleResult {
  status: 'succeeded' | 'blocked' | 'failed' | 'unconfirmed';
  code: 'VERIFIED' | 'STALE_ROLE' | 'LAST_ADMIN' | 'UNSUPPORTED_ROLE' | 'WRITE_REJECTED' | 'NOT_VERIFIED' | 'COMMUNICATION_FAILED';
  before: DeviceUserRoleSnapshot | null; after: DeviceUserRoleSnapshot | null; error: string | null;
}
export interface EmployeeClockRoleBinding {
  employeeId: string; clockRecordId: string; userId: string; uid: number | null; role: number | null; syncedAt: string; device: Device;
}
export interface DeviceUserRoleChange {
  id: string; employeeId: string; clockRecordId: string; deviceId: string; userId: string; requestedRole: WritableDeviceUserRole;
  status: 'running' | DeviceUserRoleResult['status']; before: DeviceUserRoleSnapshot | null; after: DeviceUserRoleSnapshot | null;
  code: string | null; error: string | null; startedAt: string; completedAt: string | null;
}
