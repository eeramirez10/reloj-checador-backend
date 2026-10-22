import type { DeviceClientFactory } from '../domain/datasources/device-client.js';
import type { DeviceDriver } from '../domain/entities/device.js';
import type { AttendanceRepository } from '../domain/repositories/attendance-repository.js';
import type { DeviceRepository } from '../domain/repositories/device-repository.js';
import type { EmployeeRepository } from '../domain/repositories/employee-repository.js';
import type { OrganizationRepository } from '../domain/repositories/organization-repository.js';
import type { SyncRepository } from '../domain/repositories/sync-repository.js';
import type { DeviceUserPhotoRepository, DeviceUserRepository, UserProfileRepository } from '../domain/repositories/user-repository.js';
import type { AttendanceEvaluationService } from '../domain/use-cases/evaluate-attendance.js';
import type { EmployeeRegistry } from '../domain/use-cases/manage-employee-registry.js';
import type { SyncService } from '../domain/use-cases/sync-attendance.js';
import type { UserPhotoSyncService } from '../domain/use-cases/sync-user-photos.js';
import type { UserSyncService } from '../domain/use-cases/sync-users.js';
import type { UpdateEmployee } from '../domain/use-cases/update-employee.js';
import type { GetEmployeeScheduling } from '../domain/use-cases/get-employee-scheduling.js';
import type { GetEmployeeAttendance } from '../domain/use-cases/get-employee-attendance.js';
import type { BranchConfigurationService } from '../domain/use-cases/manage-branch-configuration.js';
import type { GetBranchAttendance } from '../domain/use-cases/get-branch-attendance.js';

export interface ApplicationServices {
  devices: DeviceRepository; attendance: AttendanceRepository; syncRuns: SyncRepository;
  users: DeviceUserRepository; photos: DeviceUserPhotoRepository; employees: EmployeeRepository;
  organization: OrganizationRepository; profiles: UserProfileRepository; registry: EmployeeRegistry;
  evaluation: AttendanceEvaluationService; updateEmployee: UpdateEmployee; clients: DeviceClientFactory;
  employeeScheduling: GetEmployeeScheduling;
  employeeAttendance: GetEmployeeAttendance;
  branchConfiguration: BranchConfigurationService;
  branchAttendance: GetBranchAttendance;
  syncService: SyncService; userSyncService: UserSyncService; userPhotoSyncService: UserPhotoSyncService;
  defaultDriver: DeviceDriver; checkHealth: () => Promise<void>;
}
