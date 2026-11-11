import { createHash, randomBytes } from 'node:crypto';
import { env } from './infrastructure/config/env.js';
import { Database } from './infrastructure/database/database.js';
import { PrismaUnitOfWork } from './infrastructure/database/unit-of-work.js';
import { persistenceError } from './infrastructure/database/persistence-error.js';
import { PrismaDeviceDatasource } from './infrastructure/datasources/device-datasource.js';
import { PrismaAttendanceDatasource } from './infrastructure/datasources/attendance-datasource.js';
import { PrismaSyncDatasource } from './infrastructure/datasources/sync-datasource.js';
import { PrismaDeviceUserDatasource } from './infrastructure/datasources/device-user-datasource.js';
import { PrismaDeviceUserPhotoDatasource } from './infrastructure/datasources/device-user-photo-datasource.js';
import { PrismaEmployeeDatasource } from './infrastructure/datasources/employee-datasource.js';
import { PrismaOrganizationDatasource } from './infrastructure/datasources/organization-datasource.js';
import { PrismaUserProfileDatasource } from './infrastructure/datasources/user-profile-datasource.js';
import { PrismaEvaluationDatasource, createEvaluationSession } from './infrastructure/datasources/evaluation-datasource.js';
import { PrismaLeaveRepository, PrismaLeaveSession } from './infrastructure/repositories/leave-repository.js';
import { ManageLeave } from './domain/use-cases/manage-leave.js';
import { PrismaEmployeeRegistryDatasource } from './infrastructure/datasources/employee-registry-datasource.js';
import { PrismaEmployeeNameDatasource } from './infrastructure/datasources/employee-name-datasource.js';
import { AttendanceRepositoryImpl, DeviceRepositoryImpl, EmployeeRepositoryImpl, OrganizationRepositoryImpl,
  SyncRepositoryImpl, DeviceUserRepositoryImpl, DeviceUserPhotoRepositoryImpl, UserProfileRepositoryImpl } from './infrastructure/repositories/persistence-repositories.js';
import { EvaluationRepositoryImpl } from './infrastructure/repositories/evaluation-repository.js';
import { EmployeeRegistryRepositoryImpl } from './infrastructure/repositories/employee-registry-repository.js';
import { EmployeeNameRepositoryImpl } from './infrastructure/repositories/employee-name-repository.js';
import { ZktecoClientFactory } from './infrastructure/integrations/zkteco/client-factory.js';
import { ZktecoPhotoBridgeClient } from './infrastructure/integrations/zkteco/photo-bridge-client.js';
import { SyncScheduler } from './infrastructure/jobs/sync-scheduler.js';
import { AttendanceEvaluationService } from './domain/use-cases/evaluate-attendance.js';
import { EmployeeRegistry } from './domain/use-cases/manage-employee-registry.js';
import { EmployeeNameService } from './domain/use-cases/populate-employee-names.js';
import { SyncService } from './domain/use-cases/sync-attendance.js';
import { UserSyncService } from './domain/use-cases/sync-users.js';
import { UserPhotoSyncService } from './domain/use-cases/sync-user-photos.js';
import { UpdateEmployee } from './domain/use-cases/update-employee.js';
import type { DeviceClientFactory, PhotoClient } from './domain/datasources/device-client.js';
import { createHttpServer } from './presentation/http-server.js';
import { PrismaEmployeeSchedulingDatasource } from './infrastructure/datasources/employee-scheduling-datasource.js';
import { EmployeeSchedulingRepositoryImpl } from './infrastructure/repositories/employee-scheduling-repository.js';
import { GetEmployeeScheduling } from './domain/use-cases/get-employee-scheduling.js';
import { GetEmployeeAttendance } from './domain/use-cases/get-employee-attendance.js';
import { EmployeeAttendanceRepositoryImpl } from './infrastructure/repositories/employee-attendance-repository.js';
import { PrismaEmployeeAttendanceDatasource } from './infrastructure/datasources/employee-attendance-datasource.js';
import { PrismaBranchConfigurationDatasource } from './infrastructure/datasources/branch-configuration-datasource.js';
import { BranchConfigurationRepositoryImpl } from './infrastructure/repositories/branch-configuration-repository.js';
import { BranchConfigurationService } from './domain/use-cases/manage-branch-configuration.js';
import { GetBranchAttendance } from './domain/use-cases/get-branch-attendance.js';
import { BranchAttendanceRepositoryImpl } from './infrastructure/repositories/branch-attendance-repository.js';
import { PrismaBranchAttendanceDatasource } from './infrastructure/datasources/branch-attendance-datasource.js';
import { GetOvertimeReport } from './domain/use-cases/get-overtime-report.js';
import { ImportAttendanceFile } from './domain/use-cases/import-attendance-file.js';
import { AttendanceFileRepositoryImpl } from './infrastructure/repositories/attendance-file-repository.js';
import { PrismaAttendanceFileDatasource } from './infrastructure/datasources/attendance-file-datasource.js';
import { ManageDeviceClock } from './domain/use-cases/manage-device-clock.js';
import { DeviceClockRepositoryImpl } from './infrastructure/repositories/device-clock-repository.js';
import { PrismaDeviceClockDatasource } from './infrastructure/datasources/device-clock-datasource.js';
import { PrismaDeviceUserRoleRepository } from './infrastructure/repositories/device-user-role-repository.js';
import { ManageDeviceUserRole } from './domain/use-cases/manage-device-user-role.js';
import { whatsappConfiguration, type WhatsAppConfiguration } from './infrastructure/config/whatsapp.js';
import { PrismaWhatsAppRepository } from './infrastructure/repositories/whatsapp-repository.js';
import { TwilioWhatsAppClient } from './infrastructure/integrations/twilio/twilio-whatsapp-client.js';
import { TwilioWebhookSignature } from './infrastructure/integrations/twilio/twilio-webhook-signature.js';
import { WhatsAppWorker } from './infrastructure/jobs/whatsapp-worker.js';
import { ReceiveWhatsAppMessage } from './domain/use-cases/receive-whatsapp-message.js';
import { SendWhatsAppMessage } from './domain/use-cases/send-whatsapp-message.js';
import { UpdateWhatsAppDelivery } from './domain/use-cases/update-whatsapp-delivery.js';
import { ProcessWhatsAppInbox } from './domain/use-cases/process-whatsapp-inbox.js';
import { ResolveWhatsAppEmployee } from './domain/use-cases/resolve-whatsapp-employee.js';
import type { WhatsAppMessageHandler, WhatsAppMessaging } from './domain/datasources/whatsapp-messaging.js';
import { ManageAuth } from './domain/use-cases/manage-auth.js';
import { PrismaAuthRepository } from './infrastructure/repositories/auth-repository.js';
import { ArgonPasswordHasher } from './infrastructure/security/password-hasher.js';
import { BranchAccessControl } from './infrastructure/security/access-control.js';
import type { AuthPrincipal } from './domain/entities/auth.js';
import { PrismaEmployeeContactRepository } from './infrastructure/repositories/employee-contact-repository.js';
import { PrismaEmployeePortalRepository } from './infrastructure/repositories/employee-portal-repository.js';
import { IssueEmployeeAccess } from './domain/use-cases/issue-employee-access.js';
import { PrismaEmployeeAccessIssuer } from './infrastructure/repositories/employee-access-issuer.js';
import { MicrosoftGraphEmail } from './infrastructure/integrations/microsoft-graph-email.js';
import { EmailWorker } from './infrastructure/jobs/email-worker.js';
import type { EmailSettings } from './infrastructure/config/email.js';
import type { EmailGateway } from './domain/datasources/email-gateway.js';
import { PrismaCompanyRepository } from './infrastructure/repositories/company-repository.js';

export function createAttendanceEvaluation(database: Database, organization: PrismaOrganizationDatasource) {
  return new AttendanceEvaluationService(new EvaluationRepositoryImpl(new PrismaEvaluationDatasource(database,
    (client) => organization.refreshCurrentBranches(client))));
}

export function createEmployeeRegistry(database: Database, organization: PrismaOrganizationDatasource) {
  return new EmployeeRegistry(new EmployeeRegistryRepositoryImpl(new PrismaEmployeeRegistryDatasource(database,
    (client) => organization.refreshCurrentBranches(client))));
}

export function createEmployeeNames(database: Database) {
  return new EmployeeNameService(new EmployeeNameRepositoryImpl(new PrismaEmployeeNameDatasource(database)));
}

export interface AppDependencies {
  authentication?: { testPrincipal: AuthPrincipal };
  database?: Database; clients?: DeviceClientFactory; photoBridge?: PhotoClient;
  email?: { settings: EmailSettings; gateway?: EmailGateway };
  whatsapp?: { configuration: WhatsAppConfiguration; messaging?: WhatsAppMessaging; handler?: WhatsAppMessageHandler; now?: () => Date };
}

export async function buildApp(dependencies: AppDependencies = {}) {
  const database = dependencies.database ?? new Database(env.DATABASE_URL);
  try {
    const auth = new ManageAuth(new PrismaAuthRepository(database), new ArgonPasswordHasher(), {
      random: () => randomBytes(32).toString('base64url'), hash: value => createHash('sha256').update(value).digest('hex'),
    }, env.AUTH_SESSION_HOURS);
    const access = new BranchAccessControl(database);
    const emailSettings: EmailSettings = dependencies.email?.settings ?? { enabled: env.EMAIL_ENABLED,encryptionKey: env.EMAIL_ENCRYPTION_KEY,publicUrl: env.APP_PUBLIC_URL };
    const employeeAccess = new IssueEmployeeAccess(new PrismaEmployeeAccessIssuer(database,emailSettings),new ArgonPasswordHasher(),() => randomBytes(18).toString('base64url'));
    const emailWorker = emailSettings.enabled ? new EmailWorker(database,dependencies.email?.gateway ?? new MicrosoftGraphEmail({ tenantId: env.MICROSOFT_TENANT_ID,clientId: env.MICROSOFT_CLIENT_ID,clientSecret: env.MICROSOFT_CLIENT_SECRET,senderId: env.MICROSOFT_SENDER_ID }),emailSettings.encryptionKey) : undefined;
    const whatsappConfig = dependencies.whatsapp?.configuration ?? whatsappConfiguration(env);
    const whatsappRepository = new PrismaWhatsAppRepository(database);
    const whatsappNow = dependencies.whatsapp?.now ?? (() => new Date());
    const whatsapp = whatsappConfig ? {
      scope: { accountSid: whatsappConfig.accountSid, businessPhone: whatsappConfig.businessPhone },
      security: new TwilioWebhookSignature(whatsappConfig),
      receive: new ReceiveWhatsAppMessage(whatsappRepository,whatsappConfig,whatsappNow),
      send: new SendWhatsAppMessage(whatsappRepository,dependencies.whatsapp?.messaging ?? new TwilioWhatsAppClient(whatsappConfig),whatsappConfig,whatsappConfig.templates,whatsappNow),
      delivery: new UpdateWhatsAppDelivery(whatsappRepository,whatsappConfig,whatsappNow),
      inbox: new ProcessWhatsAppInbox(whatsappRepository,whatsappConfig,whatsappConfig.templates,dependencies.whatsapp?.handler,whatsappNow),
      employees: new ResolveWhatsAppEmployee(whatsappRepository),
    } : undefined;
    const devices = new DeviceRepositoryImpl(new PrismaDeviceDatasource(database));
    const attendance = new AttendanceRepositoryImpl(new PrismaAttendanceDatasource(database));
    const syncRuns = new SyncRepositoryImpl(new PrismaSyncDatasource(database));
    const users = new DeviceUserRepositoryImpl(new PrismaDeviceUserDatasource(database));
    const photos = new DeviceUserPhotoRepositoryImpl(new PrismaDeviceUserPhotoDatasource(database));
    const employees = new EmployeeRepositoryImpl(new PrismaEmployeeDatasource(database));
    const organizationDatasource = new PrismaOrganizationDatasource(database);
    const organization = new OrganizationRepositoryImpl(organizationDatasource);
    const profiles = new UserProfileRepositoryImpl(new PrismaUserProfileDatasource(database));
    const evaluation = createAttendanceEvaluation(database, organizationDatasource);
    const leave = new ManageLeave(new PrismaLeaveRepository(database, async (client) => {
      await organizationDatasource.refreshCurrentBranches(client);
      await evaluation.evaluate(createEvaluationSession(client));
    },env.PHONE_DEFAULT_COUNTRY,emailSettings), (value) => createHash('sha256').update(value).digest('hex'));
    const branchConfiguration = new BranchConfigurationService(new BranchConfigurationRepositoryImpl(new PrismaBranchConfigurationDatasource(database)), evaluation);
    const registry = createEmployeeRegistry(database, organizationDatasource);
    const employeeNames = createEmployeeNames(database);
    const employeeScheduling = new GetEmployeeScheduling(new EmployeeSchedulingRepositoryImpl(new PrismaEmployeeSchedulingDatasource(database)));
    const employeeAttendance = new GetEmployeeAttendance(employees, new EmployeeAttendanceRepositoryImpl(new PrismaEmployeeAttendanceDatasource(database)));
    const branchAttendanceRepository = new BranchAttendanceRepositoryImpl(new PrismaBranchAttendanceDatasource(database));
    const branchAttendance = new GetBranchAttendance(branchAttendanceRepository);
    const overtimeReport = new GetOvertimeReport(branchAttendanceRepository);
    const updateEmployee = new UpdateEmployee(new PrismaUnitOfWork(database, (client) => ({
      employees: new EmployeeRepositoryImpl(new PrismaEmployeeDatasource(client)),
      employeeScheduling: new EmployeeSchedulingRepositoryImpl(new PrismaEmployeeSchedulingDatasource(client)),
      employeeContacts: new PrismaEmployeeContactRepository(client,env.PHONE_DEFAULT_COUNTRY),
      employeeLeave: new PrismaLeaveSession(client, async () => { await evaluation.evaluate(createEvaluationSession(client)); },env.PHONE_DEFAULT_COUNTRY,emailSettings),
    })));
    const clients = dependencies.clients ?? new ZktecoClientFactory();
    const photoBridge = dependencies.photoBridge ?? new ZktecoPhotoBridgeClient(env.ZK_PHOTO_BRIDGE_URL);
    const recalculate = async () => { await employeeNames.populateMissing(); return evaluation.recalculate(); };
    const attendanceFile = new ImportAttendanceFile(new AttendanceFileRepositoryImpl(new PrismaAttendanceFileDatasource(database)),recalculate);
    const syncService = new SyncService(attendance, syncRuns, clients, recalculate,
      (deviceId, userIds) => users.ensureFromAttendance(deviceId, userIds));
    const deviceClock = new ManageDeviceClock(new DeviceClockRepositoryImpl(new PrismaDeviceClockDatasource(database)), clients, syncService);
    const deviceUserRole = new ManageDeviceUserRole(new PrismaDeviceUserRoleRepository(database),clients,syncService);
    const userSyncService = new UserSyncService(users, syncRuns, clients, syncService, recalculate);
    const userPhotoSyncService = new UserPhotoSyncService(users, photos, syncRuns, photoBridge, syncService);
    const app = await createHttpServer({
      companies: new PrismaCompanyRepository(database),
      auth, access, employeeAccess, portal: new PrismaEmployeePortalRepository(database,env.PHONE_DEFAULT_COUNTRY), contacts: new PrismaEmployeeContactRepository(database,env.PHONE_DEFAULT_COUNTRY), authentication: { origins: env.AUTH_ALLOWED_ORIGINS, secureCookie: env.AUTH_COOKIE_SECURE, sessionHours: env.AUTH_SESSION_HOURS, ...dependencies.authentication },
      devices, attendance, syncRuns, users, photos, employees, organization, profiles, registry, evaluation, updateEmployee, employeeScheduling, employeeAttendance, branchConfiguration, branchAttendance, overtimeReport, attendanceFile,
      clients, syncService, userSyncService, userPhotoSyncService, deviceClock, deviceUserRole, leave, whatsapp, defaultDriver: env.ZK_DRIVER,
      checkHealth: async () => { await database.query('SELECT 1'); },
    }, persistenceError);
    const scheduler = new SyncScheduler(devices, syncService, env.SYNC_INTERVAL_SECONDS, app.log, env.SYNC_ENABLED);
    const whatsappWorker = whatsapp ? new WhatsAppWorker(whatsappRepository,whatsapp.scope,whatsapp.inbox,whatsapp.send,app.log,whatsappNow) : undefined;
    app.addHook('onClose', async () => {
      await scheduler.stop();
      await whatsappWorker?.stop();
      await emailWorker?.stop();
      if (!dependencies.database) await database.close();
    });
    return { app, database, auth, devices, employees, organization, evaluation, employeeNames, syncService, userSyncService, userPhotoSyncService, scheduler, whatsapp, whatsappWorker, emailWorker };
  } catch (error) {
    if (!dependencies.database) await database.close();
    throw error;
  }
}
