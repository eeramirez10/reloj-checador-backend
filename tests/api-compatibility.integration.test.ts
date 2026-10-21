import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/main.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { ExternalServiceError } from '../src/domain/errors/app-error.js';
import type { DeviceClientFactory, PhotoClient } from '../src/domain/datasources/device-client.js';
import { NodeZkLibClient } from '../src/infrastructure/integrations/zkteco/node-zklib-client.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;

integration('API compatibility through Prisma and clean architecture', () => {
  const schema = `test_api_${randomUUID().replaceAll('-', '')}`;
  const image = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd9]);
  let admin: Database;
  let database: Database;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let branchId: string;
  let deviceId: string;
  let offline = false;
  const clients: DeviceClientFactory = {
    getClient: () => ({
      testConnection: async () => ({ raw: { connected: true } }),
      getUsers: async () => [{ userId: '1', name: 'Ana Prueba', raw: { original: true } }],
      getAttendance: async () => {
        if (offline) throw new ExternalServiceError('El reloj no está disponible.', 'EXTERNAL_SERVICE_UNAVAILABLE');
        return [{ deviceLogId: 'serial-1', userId: '1', occurredAt: new Date('2025-10-21T14:30:00Z'), raw: { original: true } }];
      },
    }),
  };
  const photoBridge: PhotoClient = {
    getUserPhotos: async (_device, userIds) => userIds.map((userId) => ({ userId, contentType: 'image/jpeg', dataBase64: image.toString('base64') })),
  };

  beforeAll(async () => {
    admin = new Database(connection!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(url.toString());
    await runMigrations(database);
    ({ app } = await buildApp({ database, clients, photoBridge }));
    const branch = await app.inject({ method: 'POST', url: '/branches', payload: { name: 'Sucursal de prueba' } });
    expect(branch.statusCode).toBe(201);
    branchId = branch.json<{ id: string }>().id;
    const clock = await app.inject({ method: 'POST', url: '/devices', payload: { name: 'Reloj de prueba', ipAddress: '127.0.0.10', branchId } });
    expect(clock.statusCode).toBe(201);
    deviceId = clock.json<{ id: string }>().id;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  it('preserves native employee creation and validates UUID and timezone parameters', async () => {
    const created = await app.inject({ method: 'POST', url: '/employees', payload: { firstName: 'Luis', lastName: 'Prueba', branchId } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ firstName: 'Luis', lastName: 'Prueba', identificationStatus: 'confirmed', isActive: true });
    expect((await app.inject({ method: 'GET', url: '/devices/invalid' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/attendance?timeZone=Invalid/Zone' })).statusCode).toBe(400);
  });

  it('preserves binary JPEG responses, original clock profiles and canonical employee links', async () => {
    expect((await app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-users` })).statusCode).toBe(200);
    const synced = await app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-user-photos`, payload: { userIds: ['1'] } });
    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toMatchObject({ downloadedCount: 1, missingCount: 0 });
    const photo = await app.inject({ method: 'GET', url: `/devices/${deviceId}/users/1/photo` });
    expect(photo.statusCode).toBe(200);
    expect(photo.headers['content-type']).toBe('image/jpeg');
    expect(photo.rawPayload).toEqual(image);
    const users = (await app.inject({ method: 'GET', url: `/users?deviceId=${deviceId}` })).json();
    expect(users[0]).toMatchObject({ userId: '1', hasPhoto: true, rawData: { original: true } });
    expect((await app.inject({ method: 'GET', url: `/employees/${users[0].employeeId}` })).json().clockRecords[0])
      .toMatchObject({ deviceId, userId: '1', bindingStatus: 'active', hasPhoto: true });
  });

  it('returns an operational failure and then recovers without restarting or duplicating punches', async () => {
    offline = true;
    const failed = await app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ message: 'El reloj no está disponible.' });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    offline = false;
    const successful = await app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` });
    expect(successful.json()).toMatchObject({ status: 'succeeded', receivedCount: 1, insertedCount: 1 });
    const repeated = await app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` });
    expect(repeated.json()).toMatchObject({ status: 'succeeded', insertedCount: 0 });
    const logs = (await app.inject({ method: 'GET', url: `/attendance?deviceId=${deviceId}` })).json();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ deviceLogId: 'serial-1', userId: '1', userHasPhoto: true });
  });

  it('maps database uniqueness and missing references to compatible HTTP errors', async () => {
    const duplicate = await app.inject({ method: 'POST', url: '/devices', payload: { name: 'Duplicado', ipAddress: '127.0.0.10', branchId } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ message: 'Ya existe un reloj con esa dirección IP y puerto.' });
    const missing = await app.inject({ method: 'POST', url: '/devices', payload: { name: 'Sin sucursal', ipAddress: '127.0.0.11', branchId: randomUUID() } });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).not.toHaveProperty('stack');
  });

  it('keeps the API and synchronization usable after a native SDK callback crashes', async () => {
    const client = new NodeZkLibClient(1_000, 5_200, {
      workerPath: new URL('./fixtures/zkteco-worker.cjs', import.meta.url), operationTimeoutMs: 1_000,
    });
    const isolated = await buildApp({ database, clients: { getClient: () => client }, photoBridge });
    try {
      await isolated.app.inject({ method: 'PATCH', url: `/devices/${deviceId}`, payload: { name: 'crash' } });
      const failed = await isolated.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` });
      expect(failed.statusCode).toBe(502);
      expect((await isolated.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
      const runs = (await isolated.app.inject({ method: 'GET', url: `/sync-runs?deviceId=${deviceId}` })).json();
      expect(runs[0]).toMatchObject({ status: 'failed', syncType: 'attendance' });
      await isolated.app.inject({ method: 'PATCH', url: `/devices/${deviceId}`, payload: { name: 'healthy' } });
      const recovered = await isolated.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` });
      expect(recovered.statusCode).toBe(200);
      expect(recovered.json()).toMatchObject({ status: 'succeeded', receivedCount: 1, insertedCount: 1 });
    } finally { await isolated.app.close(); }
  });

  it('uses the photo from the original punch device even when clock IDs repeat or the assigned clock changes', async () => {
    const firstUser = (await app.inject({ method: 'GET', url: `/users?deviceId=${deviceId}` })).json()[0];
    const secondClock = await app.inject({ method: 'POST', url: '/devices', payload: {
      name: 'Otro reloj', ipAddress: '127.0.0.12', branchId,
    } });
    expect(secondClock.statusCode).toBe(201);
    const secondDeviceId = secondClock.json<{ id: string }>().id;
    expect((await app.inject({ method: 'POST', url: `/devices/${secondDeviceId}/sync-users` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/devices/${secondDeviceId}/sync-attendance` })).statusCode).toBe(200);
    const secondUser = (await app.inject({ method: 'GET', url: `/users?deviceId=${secondDeviceId}` })).json()[0];
    expect(secondUser.userId).toBe(firstUser.userId);
    expect(secondUser.employeeId).not.toBe(firstUser.employeeId);

    const reportUrl = '/attendance/daily?from=2025-10-21&to=2025-10-22';
    const withoutSecondPhoto = (await app.inject({ method: 'GET', url: reportUrl })).json();
    expect(withoutSecondPhoto.find((day: { employeeId: string }) => day.employeeId === secondUser.employeeId).photo).toBeNull();
    expect(withoutSecondPhoto.find((day: { employeeId: string }) => day.employeeId === firstUser.employeeId).photo)
      .toEqual({ deviceId, userId: '1', hasPhoto: true });

    expect((await app.inject({ method: 'POST', url: `/devices/${secondDeviceId}/sync-user-photos`, payload: { userIds: ['1'] } })).statusCode).toBe(200);
    const withSecondPhoto = (await app.inject({ method: 'GET', url: reportUrl })).json();
    expect(withSecondPhoto.find((day: { employeeId: string }) => day.employeeId === secondUser.employeeId).photo)
      .toEqual({ deviceId: secondDeviceId, userId: '1', hasPhoto: true });

    expect((await app.inject({ method: 'POST', url: `/employees/${firstUser.employeeId}/identify`,
      payload: { firstName: 'Ana', lastName: 'Prueba' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/employees/${firstUser.employeeId}/clock-record`,
      payload: { clockRecordId: secondUser.id } })).statusCode).toBe(204);
    const employee = (await app.inject({ method: 'GET', url: `/employees/${firstUser.employeeId}` })).json();
    expect(employee.clockRecords.find((record: { bindingStatus: string }) => record.bindingStatus === 'active').deviceId).toBe(secondDeviceId);
    const history = (await app.inject({ method: 'GET', url: reportUrl })).json();
    expect(history.find((day: { date: string }) => day.date === '2025-10-22').photo)
      .toEqual({ deviceId, userId: '1', hasPhoto: true });
  });
});
