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
import { PrismaEvaluationDatasource } from './infrastructure/datasources/evaluation-datasource.js';
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

export interface AppDependencies { database?: Database; clients?: DeviceClientFactory; photoBridge?: PhotoClient }

export async function buildApp(dependencies: AppDependencies = {}) {
  const database = dependencies.database ?? new Database(env.DATABASE_URL);
  try {
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
    const registry = createEmployeeRegistry(database, organizationDatasource);
    const employeeNames = createEmployeeNames(database);
    const updateEmployee = new UpdateEmployee(new PrismaUnitOfWork(database, (client) => ({
      employees: new EmployeeRepositoryImpl(new PrismaEmployeeDatasource(client)),
    })));
    const clients = dependencies.clients ?? new ZktecoClientFactory();
    const photoBridge = dependencies.photoBridge ?? new ZktecoPhotoBridgeClient(env.ZK_PHOTO_BRIDGE_URL);
    const recalculate = async () => { await employeeNames.populateMissing(); return evaluation.recalculate(); };
    const syncService = new SyncService(attendance, syncRuns, clients, recalculate,
      (deviceId, userIds) => users.ensureFromAttendance(deviceId, userIds));
    const userSyncService = new UserSyncService(users, syncRuns, clients, syncService, recalculate);
    const userPhotoSyncService = new UserPhotoSyncService(users, photos, syncRuns, photoBridge, syncService);
    const app = await createHttpServer({
      devices, attendance, syncRuns, users, photos, employees, organization, profiles, registry, evaluation, updateEmployee,
      clients, syncService, userSyncService, userPhotoSyncService, defaultDriver: env.ZK_DRIVER,
      checkHealth: async () => { await database.query('SELECT 1'); },
    }, persistenceError);
    const scheduler = new SyncScheduler(devices, syncService, env.SYNC_INTERVAL_SECONDS, app.log);
    app.addHook('onClose', async () => {
      await scheduler.stop();
      if (!dependencies.database) await database.close();
    });
    return { app, database, devices, employees, organization, evaluation, employeeNames, syncService, userSyncService, userPhotoSyncService, scheduler };
  } catch (error) {
    if (!dependencies.database) await database.close();
    throw error;
  }
}
