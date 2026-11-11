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
import type { GetOvertimeReport } from '../domain/use-cases/get-overtime-report.js';
import type { ImportAttendanceFile } from '../domain/use-cases/import-attendance-file.js';
import type { ManageDeviceClock } from '../domain/use-cases/manage-device-clock.js';
import type { ManageLeave } from '../domain/use-cases/manage-leave.js';
import type { ManageDeviceUserRole } from '../domain/use-cases/manage-device-user-role.js';
import type { WhatsAppWebhookSecurity } from '../domain/datasources/whatsapp-messaging.js';
import type { WhatsAppScope } from '../domain/entities/whatsapp-message.js';
import type { ReceiveWhatsAppMessage } from '../domain/use-cases/receive-whatsapp-message.js';
import type { SendWhatsAppMessage } from '../domain/use-cases/send-whatsapp-message.js';
import type { UpdateWhatsAppDelivery } from '../domain/use-cases/update-whatsapp-delivery.js';
import type { ProcessWhatsAppInbox } from '../domain/use-cases/process-whatsapp-inbox.js';
import type { ResolveWhatsAppEmployee } from '../domain/use-cases/resolve-whatsapp-employee.js';
import type { ManageAuth } from '../domain/use-cases/manage-auth.js';
import type { AccessControl } from '../domain/datasources/access-control.js';
import type { AuthPrincipal } from '../domain/entities/auth.js';
import type { EmployeePortalRepository } from '../domain/repositories/employee-portal-repository.js';
import type { EmployeeContactRepository } from '../domain/repositories/employee-contact-repository.js';
import type { IssueEmployeeAccess } from '../domain/use-cases/issue-employee-access.js';
import type { CompanyRepository } from '../domain/repositories/company-repository.js';

export interface WhatsAppServices {
  scope: WhatsAppScope; security: WhatsAppWebhookSecurity; receive: ReceiveWhatsAppMessage; send: SendWhatsAppMessage;
  delivery: UpdateWhatsAppDelivery; inbox: ProcessWhatsAppInbox; employees: ResolveWhatsAppEmployee;
}

export interface ApplicationServices {
  auth: ManageAuth;
  companies: CompanyRepository;
  portal: EmployeePortalRepository;
  contacts: EmployeeContactRepository;
  employeeAccess: IssueEmployeeAccess;
  access: AccessControl;
  authentication: { origins: string[]; secureCookie: boolean; sessionHours: number; testPrincipal?: AuthPrincipal };
  whatsapp?: WhatsAppServices;
  devices: DeviceRepository; attendance: AttendanceRepository; syncRuns: SyncRepository;
  users: DeviceUserRepository; photos: DeviceUserPhotoRepository; employees: EmployeeRepository;
  organization: OrganizationRepository; profiles: UserProfileRepository; registry: EmployeeRegistry;
  evaluation: AttendanceEvaluationService; updateEmployee: UpdateEmployee; clients: DeviceClientFactory;
  employeeScheduling: GetEmployeeScheduling;
  employeeAttendance: GetEmployeeAttendance;
  branchConfiguration: BranchConfigurationService;
  branchAttendance: GetBranchAttendance;
  overtimeReport: GetOvertimeReport;
  attendanceFile: ImportAttendanceFile;
  deviceClock: ManageDeviceClock;
  leave: ManageLeave;
  deviceUserRole: ManageDeviceUserRole;
  syncService: SyncService; userSyncService: UserSyncService; userPhotoSyncService: UserPhotoSyncService;
  defaultDriver: DeviceDriver; checkHealth: () => Promise<void>;
}
