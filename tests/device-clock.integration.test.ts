import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './helpers/build-test-app.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { formatDateTimeInTimeZone } from '../src/domain/entities/attendance-summary.js';
import type { Device } from '../src/domain/entities/device.js';
import { clockWallTimeMilliseconds } from '../src/domain/entities/device-clock.js';
import { ExternalServiceError } from '../src/domain/errors/app-error.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;
const instant = new Date('2026-10-28T16:30:00Z');

integration('clock administration and audit in PostgreSQL', () => {
  const schema = `test_device_clock_${randomUUID().replaceAll('-', '')}`;
  let admin: Database; let database: Database; let services: Awaited<ReturnType<typeof buildApp>>;
  let deviceId: string; let counter = 0; let offset = 305; let ignoreWrite = false; let failAfterWrite = false;
  const read = vi.fn(async (device: Device) => {
    if (failAfterWrite && write.mock.calls.length) throw new Error('Lectura posterior sin conexión');
    return { localTime: formatDateTimeInTimeZone(new Date(instant.getTime() + offset * 1000), device.timeZone!), measuredAt: instant.toISOString() };
  });
  const write = vi.fn(async (device: Device, manualTime?: string) => {
    const reference = formatDateTimeInTimeZone(instant, device.timeZone!);
    if (!ignoreWrite) offset = manualTime ? (clockWallTimeMilliseconds(manualTime) - clockWallTimeMilliseconds(reference)) / 1000 : 0;
    return { localTime: manualTime ?? reference, sentAt: instant.toISOString() };
  });
  const baseClient = { testConnection: async () => ({ raw: {} }), getUsers: async () => [], getAttendance: async () => [
    { deviceLogId: '1', userId: '515', occurredAt: new Date('2026-10-20T14:30:00Z'), verificationType: 1, punchState: 0, raw: { original: true } },
  ] };
  beforeAll(async () => {
    admin = new Database(connection!); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!); scoped.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(scoped.toString()); await runMigrations(database);
    services = await buildApp({ database, clients: { getClient: (device) => device.driver === 'sdk-bridge' ? baseClient : { ...baseClient, getClockTime: read, setClockTime: write } } });
  }, 30000);
  beforeEach(async () => {
    read.mockClear(); write.mockClear(); offset = 305; ignoreWrite = false; failAfterWrite = false;
    const branch = (await services.app.inject({ method: 'POST', url: '/branches', payload: { name: `Sucursal reloj ${++counter}`, timeZone: counter % 2 ? 'America/Mexico_City' : 'America/Cancun' } })).json();
    deviceId = (await services.app.inject({ method: 'POST', url: '/devices', payload: { name: `Reloj ${counter}`, ipAddress: `127.2.0.${counter}`, branchId: branch.id } })).json().id;
  });
  afterAll(async () => { await services?.app.close(); await database?.close(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); } });

  it('reads drift without writing the device, starting an audit or altering original attendance', async () => {
    expect((await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` })).statusCode).toBe(200);
    const source = (await database.query('SELECT to_jsonb(a) AS record FROM attendance_logs a WHERE device_id=$1', [deviceId])).rows;
    const response = await services.app.inject({ method: 'GET', url: `/devices/${deviceId}/clock-time` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ localTime: '2026-10-28 10:35:05', referenceLocalTime: '2026-10-28 10:30:00', timeZone: 'America/Mexico_City', driftSeconds: 305 });
    expect(write).not.toHaveBeenCalled();
    expect((await services.app.inject({ method: 'GET', url: `/devices/${deviceId}/clock-time/history` })).json()).toEqual([]);
    expect((await database.query('SELECT to_jsonb(a) AS record FROM attendance_logs a WHERE device_id=$1', [deviceId])).rows).toEqual(source);
  });

  it('synchronizes in Cancun local time, reads back and preserves all original attendance and identity data', async () => {
    await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` });
    const before = (await database.query('SELECT to_jsonb(a) AS record FROM attendance_logs a WHERE device_id=$1', [deviceId])).rows;
    const users = (await database.query('SELECT to_jsonb(u) AS record FROM device_users u WHERE device_id=$1', [deviceId])).rows;
    const response = await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/clock-time/synchronize`, payload: {} });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ deviceId, mode: 'server', requestedLocalTime: null, status: 'succeeded', timeZone: 'America/Cancun', before: { driftSeconds: 305 }, target: { localTime: '2026-10-28 11:30:00' }, after: { localTime: '2026-10-28 11:30:00', driftSeconds: 0 }, error: null });
    expect(read).toHaveBeenCalledTimes(2); expect(write).toHaveBeenCalledOnce();
    const history = (await services.app.inject({ method: 'GET', url: `/devices/${deviceId}/clock-time/history` })).json();
    expect(history).toHaveLength(1); expect(history[0]).toEqual(response.json());
    expect((await database.query('SELECT to_jsonb(a) AS record FROM attendance_logs a WHERE device_id=$1', [deviceId])).rows).toEqual(before);
    expect((await database.query('SELECT to_jsonb(u) AS record FROM device_users u WHERE device_id=$1', [deviceId])).rows).toEqual(users);
  });

  it('records a failed verification when the device acknowledges but ignores the requested time', async () => {
    ignoreWrite = true;
    const response = await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/clock-time/synchronize` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'failed', after: { driftSeconds: 305 }, error: expect.stringContaining('no confirmó') });
    expect(response.json().completedAt).toBeTruthy();
  });

  it('retains the previous and sent times if the verification connection fails', async () => {
    failAfterWrite = true;
    const response = await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/clock-time/synchronize` });
    expect(response.statusCode).toBe(500);
    const [entry] = (await services.app.inject({ method: 'GET', url: `/devices/${deviceId}/clock-time/history` })).json();
    expect(entry).toMatchObject({ status: 'failed', before: { driftSeconds: 305 }, target: { localTime: '2026-10-28 11:30:00' }, after: null, error: 'Lectura posterior sin conexión' });
  });

  it('rejects concurrent clock commands, connection tests and attendance synchronization, then releases the lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
    read.mockImplementationOnce(async () => { entered(); await gate; return { localTime: '2026-10-28 10:30:00', measuredAt: instant.toISOString() }; });
    const first = services.app.inject({ method: 'GET', url: `/devices/${deviceId}/clock-time` });
    const pending = Promise.resolve(first); await started;
    for (const path of ['clock-time/synchronize', 'test-connection', 'sync-attendance', 'sync-users']) {
      expect((await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/${path}` })).statusCode, path).toBe(409);
    }
    release(); expect((await pending).statusCode).toBe(200);
    expect((await services.app.inject({ method: 'GET', url: `/devices/${deviceId}/clock-time` })).statusCode).toBe(200);
    expect(write).not.toHaveBeenCalled();
  });

  it('validates identity and payload and rejects a driver without clock management support', async () => {
    expect((await services.app.inject({ method: 'GET', url: '/devices/not-a-uuid/clock-time' })).statusCode).toBe(400);
    expect((await services.app.inject({ method: 'GET', url: `/devices/${randomUUID()}/clock-time` })).statusCode).toBe(404);
    expect((await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/clock-time/synchronize`, payload: { localTime: '2000-01-01 00:00:00' } })).statusCode).toBe(400);
    await database.query("UPDATE devices SET driver='sdk-bridge' WHERE id=$1", [deviceId]);
    expect((await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/clock-time/synchronize` })).statusCode).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });

  it('sets an exact manual local time, verifies against the request instead of server time and preserves source logs', async () => {
    await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` });
    const source = (await database.query('SELECT to_jsonb(a) AS record FROM attendance_logs a WHERE device_id=$1', [deviceId])).rows;
    const localTime = '2025-12-31 23:59:58';
    const response = await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/clock-time/manual`, payload: { localTime } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ mode: 'manual', requestedLocalTime: localTime, status: 'succeeded', target: { localTime }, after: { localTime }, error: null });
    expect(response.json().after.driftSeconds).not.toBe(0);
    expect(write.mock.calls[0][1]).toBe(localTime);
    expect((await services.app.inject({ method: 'GET', url: `/devices/${deviceId}/clock-time/history` })).json()[0]).toEqual(response.json());
    expect((await database.query('SELECT to_jsonb(a) AS record FROM attendance_logs a WHERE device_id=$1', [deviceId])).rows).toEqual(source);
  });

  it('does not mistake the unchanged correct server time for a successful manual adjustment', async () => {
    offset = 0; ignoreWrite = true;
    const response = await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/clock-time/manual`, payload: { localTime: '2025-12-31 23:59:58' } });
    expect(response.json()).toMatchObject({ mode: 'manual', status: 'failed', after: { driftSeconds: 0 }, error: expect.stringContaining('no confirmó') });
  });

  it('rejects invalid manual dates and extra fields before contacting the clock or creating an audit', async () => {
    const url = `/devices/${deviceId}/clock-time/manual`;
    for (const localTime of ['2026-02-29 08:00:00', '2100-01-01 08:00:00', '2026-10-28 08:00:00Z', '2026-10-28 25:00:00']) {
      expect((await services.app.inject({ method: 'POST', url, payload: { localTime } })).statusCode, localTime).toBe(400);
    }
    expect((await services.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(400);
    expect((await services.app.inject({ method: 'POST', url, payload: { localTime: '2026-10-28 08:00:00', timeZone: 'UTC' } })).statusCode).toBe(400);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    expect((await services.app.inject({ method: 'GET', url: `/devices/${deviceId}/clock-time/history` })).json()).toEqual([]);
  });

  it('records the manual request even if the clock is offline before the initial reading', async () => {
    read.mockRejectedValueOnce(new ExternalServiceError('Reloj sin conexión'));
    const localTime = '2026-10-28 08:00:00';
    const response = await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/clock-time/manual`, payload: { localTime } });
    expect(response.statusCode).toBe(502);
    const [entry] = (await services.app.inject({ method: 'GET', url: `/devices/${deviceId}/clock-time/history` })).json();
    expect(entry).toMatchObject({ mode: 'manual', requestedLocalTime: localTime, status: 'failed', before: null, target: null, after: null, error: 'Reloj sin conexión' });
    expect(write).not.toHaveBeenCalled();
  });
});
