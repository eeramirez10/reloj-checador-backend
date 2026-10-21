import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import { z } from 'zod';
import { env } from './config/env.js';
import { Database } from './db/database.js';
import { DeviceRepository, type DeviceDriver } from './devices/device-repository.js';
import { AttendanceRepository } from './attendance/attendance-repository.js';
import { formatDateTimeInTimeZone, summarizeAttendance } from './attendance/attendance-summary.js';
import { ZktecoClientFactory } from './integrations/zkteco/client-factory.js';
import { PhotoBridgeError, ZktecoPhotoBridgeClient } from './integrations/zkteco/photo-bridge-client.js';
import { SyncAlreadyRunningError, SyncService } from './sync/sync-service.js';
import { SyncRepository } from './sync/sync-repository.js';
import { DeviceUserRepository } from './users/device-user-repository.js';
import { DeviceUserPhotoRepository } from './users/device-user-photo-repository.js';
import { UserSyncService } from './users/user-sync-service.js';
import { UnknownDevicePhotoUsersError, UserPhotoSyncService } from './users/user-photo-sync-service.js';
import { EmployeeRepository } from './employees/employee-repository.js';
import { OrganizationRepository } from './organization/organization-repository.js';
import { registerOrganizationRoutes } from './organization/organization-routes.js';
import { AttendanceEvaluationService } from './attendance/attendance-evaluation-service.js';
import { ConfigurationError } from './organization/schemas.js';
import { EmployeeNameService } from './employees/employee-name-service.js';

const deviceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  ipAddress: z.string().ip({ version: 'v4' }),
  tcpPort: z.number().int().min(1).max(65535).optional(),
  driver: z.enum(['node', 'sdk-bridge']).optional(),
  enabled: z.boolean().optional(),
  syncIntervalSeconds: z.number().int().min(15).max(86400).optional()
});

export interface AppDependencies {
  database?: Database;
  clients?: ZktecoClientFactory;
  photoBridge?: ZktecoPhotoBridgeClient;
}

export async function buildApp(dependencies: AppDependencies = {}) {
  const database = dependencies.database ?? new Database(env.DATABASE_URL);
  const devices = new DeviceRepository(database);
  const attendance = new AttendanceRepository(database);
  const syncRuns = new SyncRepository(database);
  const users = new DeviceUserRepository(database);
  const photos = new DeviceUserPhotoRepository(database);
  const employees = new EmployeeRepository(database);
  const organization = new OrganizationRepository(database);
  const evaluation = new AttendanceEvaluationService(database, organization);
  const employeeNames = new EmployeeNameService(database);
  const recalculateSyncedAttendance = async () => { await employeeNames.populateMissing(); return evaluation.recalculate(); };
  const clients = dependencies.clients ?? new ZktecoClientFactory();
  const photoBridge = dependencies.photoBridge ?? new ZktecoPhotoBridgeClient(env.ZK_PHOTO_BRIDGE_URL);
  const syncService = new SyncService(attendance, syncRuns, clients, recalculateSyncedAttendance, (deviceId, userIds) => users.ensureFromAttendance(deviceId, userIds));
  const userSyncService = new UserSyncService(users, syncRuns, clients, syncService, recalculateSyncedAttendance);
  const userPhotoSyncService = new UserPhotoSyncService(users, photos, syncRuns, photoBridge, syncService);
  const app = Fastify({ logger: true });

  await app.register(helmet);
  await app.register(cors, { origin: false });
  await app.register(swagger, { openapi: { info: { title: 'Reloj Checador API', version: '0.1.0' } } });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.get('/health', { schema: { tags: ['system'] } }, async () => ({ status: 'ok' }));
  app.get('/devices', { schema: { tags: ['devices'] } }, async () => { await organization.refreshCurrentBranches(); return devices.list(); });
  app.get('/devices/:id', { schema: { tags: ['devices'] } }, async (request, reply) => {
    const device = await devices.findById((request.params as { id: string }).id);
    return device ?? reply.code(404).send({ message: 'Dispositivo no encontrado.' });
  });
  app.post('/devices', { schema: { tags: ['devices'] } }, async (request, reply) => {
    const input = deviceSchema.extend({ branchId: z.string().uuid() }).parse(request.body);
    return reply.code(201).send(await devices.create({ ...input, driver: input.driver ?? env.ZK_DRIVER }));
  });
  app.patch('/devices/:id', { schema: { tags: ['devices'] } }, async (request, reply) => {
    const input = deviceSchema.partial().parse(request.body);
    const device = await devices.update((request.params as { id: string }).id, input);
    return device ?? reply.code(404).send({ message: 'Dispositivo no encontrado.' });
  });
  app.delete('/devices/:id', { schema: { tags: ['devices'] } }, async (request, reply) => {
    const deleted = await devices.softDelete((request.params as { id: string }).id);
    return deleted ? reply.code(204).send() : reply.code(404).send({ message: 'Dispositivo no encontrado.' });
  });
  app.post('/devices/:id/test-connection', { schema: { tags: ['devices'] } }, async (request, reply) => {
    const device = await devices.findById((request.params as { id: string }).id);
    if (!device) return reply.code(404).send({ message: 'Dispositivo no encontrado.' });
    return clients.getClient(device).testConnection(device);
  });
  app.post('/devices/:id/sync-attendance', { schema: { tags: ['attendance'] } }, async (request, reply) => {
    const device = await devices.findById((request.params as { id: string }).id);
    if (!device) return reply.code(404).send({ message: 'Dispositivo no encontrado.' });
    try { return await syncService.sync(device); }
    catch (error) {
      if (error instanceof SyncAlreadyRunningError) return reply.code(409).send({ message: error.message });
      throw error;
    }
  });
  app.post('/devices/:id/sync-users', { schema: { tags: ['users'] } }, async (request, reply) => {
    await organization.refreshCurrentBranches();
    const device = await devices.findById((request.params as { id: string }).id);
    if (!device) return reply.code(404).send({ message: 'Dispositivo no encontrado.' });
    try { return await userSyncService.sync(device); }
    catch (error) {
      if (error instanceof SyncAlreadyRunningError) return reply.code(409).send({ message: error.message });
      throw error;
    }
  });
  app.post('/devices/:id/sync-user-photos', { schema: { tags: ['users'] } }, async (request, reply) => {
    const device = await devices.findById((request.params as { id: string }).id);
    if (!device) return reply.code(404).send({ message: 'Dispositivo no encontrado.' });
    const input = z.object({
      userIds: z.array(z.string().trim().min(1).max(32)).min(1).max(25)
        .refine((userIds) => new Set(userIds).size === userIds.length, 'No repitas IDs de usuario.')
        .optional()
    }).parse(request.body ?? {});
    try { return await userPhotoSyncService.sync(device, input.userIds); }
    catch (error) {
      if (error instanceof SyncAlreadyRunningError) return reply.code(409).send({ message: error.message });
      if (error instanceof PhotoBridgeError) {
        return reply.code(error.statusCode).send({ message: error.message });
      }
      if (error instanceof UnknownDevicePhotoUsersError) return reply.code(400).send({ message: error.message });
      throw error;
    }
  });
  app.get('/devices/:deviceId/users/:userId/photo', { schema: { tags: ['users'] } }, async (request, reply) => {
    const params = z.object({ deviceId: z.string().uuid(), userId: z.string().min(1) }).parse(request.params);
    const photo = await photos.findByUserId(params.deviceId, params.userId);
    if (!photo) return reply.code(404).send({ message: 'El usuario no tiene una foto disponible.' });
    return reply
      .type(photo.contentType)
      .header('cache-control', 'private, max-age=300')
      .send(photo.imageData);
  });
  app.get('/attendance', { schema: { tags: ['attendance'] } }, async (request) => {
    const query = z.object({ deviceId: z.string().uuid().optional(), branchId: z.string().uuid().optional(), userId: z.string().min(1).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), timeZone: z.string().default('America/Mexico_City'), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    try {
      const logs = await attendance.list(query);
      return logs.map((log) => ({ ...log, occurredAtLocal: formatDateTimeInTimeZone(log.occurredAt, query.timeZone) }));
    } catch (error) {
      if (error instanceof RangeError) return { message: 'Zona horaria inválida.' };
      throw error;
    }
  });
  app.get('/users/:userId/attendance-summary', { schema: { tags: ['attendance'] } }, async (request) => {
    const params = z.object({ userId: z.string().min(1) }).parse(request.params);
    const query = z.object({ deviceId: z.string().uuid(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), timeZone: z.string().default('America/Mexico_City') }).parse(request.query);
    try {
      // This device does not currently expose punch state, so entries and exits are inferred chronologically.
      const logs = await attendance.list({ ...query, userId: params.userId, limit: 5_000 });
      const summaries = summarizeAttendance(logs, query.timeZone).map((summary) => ({
        ...summary,
        firstEntryLocal: summary.firstEntry && formatDateTimeInTimeZone(summary.firstEntry, query.timeZone),
        lastExitLocal: summary.lastExit && formatDateTimeInTimeZone(summary.lastExit, query.timeZone),
        openEntryLocal: summary.openEntry && formatDateTimeInTimeZone(summary.openEntry, query.timeZone),
        sessions: summary.sessions.map((session) => ({
          ...session,
          entryLocal: formatDateTimeInTimeZone(session.entry, query.timeZone),
          exitLocal: session.exit && formatDateTimeInTimeZone(session.exit, query.timeZone)
        })),
        punches: summary.punches.map((punch) => ({ ...punch, occurredAtLocal: formatDateTimeInTimeZone(punch.occurredAt, query.timeZone) }))
      }));
      return { deviceId: query.deviceId, userId: params.userId, timeZone: query.timeZone, displayFormat: 'YYYY-MM-DD HH:mm:ss', summaries };
    } catch (error) {
      if (error instanceof RangeError) return { message: 'Zona horaria inválida.' };
      throw error;
    }
  });
  app.get('/sync-runs', { schema: { tags: ['sync'] } }, async (request) => {
    const query = z.object({ deviceId: z.string().uuid().optional() }).parse(request.query);
    return syncRuns.list(query.deviceId);
  });
  app.get('/users', { schema: { tags: ['users'] } }, async (request) => {
    await organization.refreshCurrentBranches();
    const query = z.object({ deviceId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    return users.list(query);
  });
  app.get('/employees', { schema: { tags: ['employees'] } }, async (request) => {
    await organization.refreshCurrentBranches();
    const query = z.object({
      search: z.string().trim().max(120).optional(),
      branchCode: z.string().trim().max(20).optional(),
      employmentStatus: z.enum(['active', 'inactive', 'pending']).optional(),
      identificationStatus: z.enum(['confirmed', 'pending']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(500)
    }).parse(request.query);
    return employees.list(query);
  });

  registerOrganizationRoutes(app, { organization, database, evaluation });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ message: error.issues.find((issue) => issue.code === 'custom')?.message ?? 'Solicitud inválida.', issues: error.issues });
    if (error instanceof ConfigurationError) return reply.code(400).send({ message: error.message });
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === '23505') return reply.code(409).send({ message: 'constraint' in error && error.constraint === 'devices_active_endpoint_idx'
        ? 'Ya existe un reloj con esa dirección IP y puerto.' : 'constraint' in error && error.constraint === 'device_users_active_employee_idx'
          ? 'El empleado ya tiene un reloj actual asignado.' : 'Ya existe un registro con esos datos.' });
      if (error.code === '23503') return reply.code(400).send({ message: 'La sucursal, persona u horario seleccionado no existe.' });
    }
    app.log.error(error);
    return reply.code(500).send({ message: 'Error interno.' });
  });
  app.addHook('onClose', async () => { if (!dependencies.database) await database.close(); });

  return { app, database, devices, employees, organization, evaluation, employeeNames, syncService, userSyncService, userPhotoSyncService };
}
