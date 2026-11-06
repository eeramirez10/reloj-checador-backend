import type { DeviceUserRoleChange, DeviceUserRoleInput, DeviceUserRoleResult, DeviceUserRoleSnapshot, EmployeeClockRoleBinding } from '../entities/device-user-role.js';

export interface DeviceUserRoleRepository {
  binding(employeeId: string, clockRecordId: string): Promise<EmployeeClockRoleBinding>;
  start(binding: EmployeeClockRoleBinding, input: DeviceUserRoleInput): Promise<DeviceUserRoleChange>;
  finish(id: string, result: DeviceUserRoleResult): Promise<DeviceUserRoleChange>;
  saveObserved(binding: EmployeeClockRoleBinding, snapshot: DeviceUserRoleSnapshot): Promise<void>;
  history(employeeId: string): Promise<DeviceUserRoleChange[]>;
}
