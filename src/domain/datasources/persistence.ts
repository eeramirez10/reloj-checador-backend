import type { AttendanceRepository } from '../repositories/attendance-repository.js';
import type { DeviceRepository } from '../repositories/device-repository.js';
import type { EmployeeRepository } from '../repositories/employee-repository.js';
import type { OrganizationRepository } from '../repositories/organization-repository.js';
import type { SyncRepository } from '../repositories/sync-repository.js';
import type { DeviceUserPhotoRepository, DeviceUserRepository, UserProfileRepository } from '../repositories/user-repository.js';

export interface AttendanceDatasource extends AttendanceRepository {}
export interface DeviceDatasource extends DeviceRepository {}
export interface EmployeeDatasource extends EmployeeRepository {}
export interface OrganizationDatasource extends OrganizationRepository {}
export interface SyncDatasource extends SyncRepository {}
export interface DeviceUserDatasource extends DeviceUserRepository {}
export interface DeviceUserPhotoDatasource extends DeviceUserPhotoRepository {}
export interface UserProfileDatasource extends UserProfileRepository {}
