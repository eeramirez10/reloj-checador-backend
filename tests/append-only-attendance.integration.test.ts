import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, createEmployeeNames } from './helpers/build-test-app.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { PrismaAttendanceDatasource } from '../src/infrastructure/datasources/attendance-datasource.js';
import type { ZktecoAttendanceEvent } from '../src/domain/datasources/device-client.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;
const event = (deviceLogId: string, userId: string, day: string, time: string): ZktecoAttendanceEvent => ({ deviceLogId, userId,
  occurredAt: new Date(`${day}T${time}Z`), verificationType: 1, punchState: 0,
  raw: { userSn: deviceLogId, deviceLocalTime: `${day} ${String(Number(time.slice(0,2)) - 6).padStart(2,'0')}${time.slice(2)}`, deviceTimeZone: 'America/Mexico_City' } });

integration('append-only attendance across cleared clocks and reused sequence numbers', () => {
  const schema = `test_append_attendance_${randomUUID().replaceAll('-','')}`;
  let admin: Database; let database: Database; let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let deviceId: string; let branchId: string; let source: PrismaAttendanceDatasource;
  let events = [event('1','3039','2026-10-21','14:30:00'),event('2','3039','2026-10-21','23:30:00')];
  const download = vi.fn(async () => events);
  async function sync() {
    const response = await app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` });
    expect(response.statusCode,response.body).toBe(200); return response.json();
  }
  async function originals() {
    return (await database.query<{ id: string; record: unknown }>('SELECT id,to_jsonb(a) AS record FROM attendance_logs a WHERE device_id=$1 ORDER BY id',[deviceId])).rows;
  }
  beforeAll(async () => {
    admin = new Database(connection!); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!); scoped.searchParams.set('options',`-c search_path=${schema}`);
    database = new Database(scoped.toString()); await runMigrations(database);
    ({ app } = await buildApp({ database, clients: { getClient: () => ({ testConnection: async () => ({ raw: {} }), getUsers: async () => [], getAttendance: download }) } }));
    branchId = (await app.inject({ method: 'POST', url: '/branches', payload: { name: 'México historial' } })).json().id;
    expect((await app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: { effectiveFrom: '2026-01-01',
      workHours: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30' }, meal: { mode: 'disabled', startTime: '13:00', endTime: '13:00', durationMinutes: 60 }, recognitionMarginMinutes: 30,
      policy: { entryToleranceMinutes: 15, mealToleranceMinutes: 15, entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 } } })).statusCode).toBe(201);
    deviceId = (await app.inject({ method: 'POST', url: '/devices', payload: { name: 'Reloj México', ipAddress: '127.0.0.91', branchId } })).json().id;
    source = new PrismaAttendanceDatasource(database);
    expect((await sync()).insertedCount).toBe(2);
  },30000);
  afterAll(async () => { await app?.close(); await database?.close(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); } });

  it('keeps full database history and serves it without consulting a clock that now returns zero records', async () => {
    const before = await originals(); events = [];
    expect(await sync()).toMatchObject({ receivedCount: 0, insertedCount: 0 });
    expect(await originals()).toEqual(before);
    const calls = download.mock.calls.length;
    const logs = await app.inject({ method: 'GET', url: `/attendance?deviceId=${deviceId}&from=2026-10-21T06:00:00Z&to=2026-10-22T05:59:59Z` });
    expect(logs.json()).toHaveLength(2);
    const daily = await app.inject({ method: 'GET', url: `/attendance/daily?branchId=${branchId}&from=2026-10-21&to=2026-10-21` });
    expect(daily.json()[0].result).toMatchObject({ status: 'complete', entry: '2026-10-21T14:30:00.000Z', exit: '2026-10-21T23:30:00.000Z' });
    const employeeId = logs.json()[0].employeeId;
    const card = await app.inject({ method: 'GET', url: `/employees/${employeeId}/attendance?from=2026-10-21&to=2026-10-21` });
    expect(card.json().days[0].punches).toHaveLength(2);
    expect(download.mock.calls.length).toBe(calls);
  });

  it('adds reused sequence numbers on a later day without changing any earlier ID, timestamp or raw evidence', async () => {
    const before = await originals();
    events = [event('1','3039','2026-10-22','14:31:00'),event('2','3039','2026-10-22','23:32:00')];
    expect((await sync()).insertedCount).toBe(2);
    const after = await originals(); expect(after).toHaveLength(4);
    for (const row of before) expect(after.find((item) => item.id === row.id)).toEqual(row);
    expect((await sync()).insertedCount).toBe(0);
    expect(await originals()).toEqual(after);
  });

  it('keeps partial downloads and reused folios belonging to other users as separate events', async () => {
    const before = await originals();
    events = [event('1','3040','2026-10-22','14:31:00')];
    expect((await sync()).insertedCount).toBe(1);
    const after = await originals(); expect(after).toHaveLength(before.length + 1);
    for (const row of before) expect(after.find((item) => item.id === row.id)).toEqual(row);
    const changed = { ...events[0], verificationType: 15, punchState: 1, raw: { ...events[0].raw as object, updated: true } };
    expect(await source.insertIfNew(deviceId,changed)).toBe(false);
    expect(await originals()).toEqual(after);
  });

  it('recognizes legacy bare-folio and hash identities without rewriting or duplicating them', async () => {
    const legacy = event('legacy-1','3039','2026-10-20','14:30:00');
    const noId = { userId: '3039', occurredAt: new Date('2026-10-20T23:30:00Z'), raw: { original: 'legacy hash' } };
    const oldHash = createHash('sha256').update(JSON.stringify([noId.userId,noId.occurredAt.toISOString(),undefined,undefined])).digest('hex');
    for (const [key,item] of [['legacy-1',legacy],[oldHash,noId]] as const) await database.query(`INSERT INTO attendance_logs
      (id,device_id,event_key,device_log_id,user_id,occurred_at,raw_data,branch_id) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [randomUUID(),deviceId,key,'deviceLogId' in item ? item.deviceLogId : null,item.userId,item.occurredAt,JSON.stringify(item.raw),branchId]);
    const before = await originals();
    expect(await source.insertIfNew(deviceId,legacy)).toBe(false);
    expect(await source.insertIfNew(deviceId,noId)).toBe(false);
    expect(await originals()).toEqual(before);
    const reinterpreted = { ...legacy, occurredAt: new Date('2026-10-20T13:30:00Z'), raw: { ...legacy.raw as object, deviceTimeZone: 'America/Cancun' } };
    expect(await source.insertIfNew(deviceId,reinterpreted)).toBe(false);
    expect(await originals()).toEqual(before);
  });

  it('does not hide a historical raw-userSn record when that serial is reused for a different date', async () => {
    const id = randomUUID();
    await database.query(`INSERT INTO attendance_logs (id,device_id,event_key,user_id,occurred_at,raw_data,branch_id)
      VALUES ($1,$2,$3,'3039','2026-10-19T14:30:00Z',$4::jsonb,$5)`,[id,deviceId,`old-${id}`,JSON.stringify({ userSn: 'reused-raw', original: true }),branchId]);
    expect(await source.insertIfNew(deviceId,event('reused-raw','3039','2026-10-20','14:30:00'))).toBe(true);
    const logs = await source.list({ deviceId, from: new Date('2026-10-19T06:00:00Z'), to: new Date('2026-10-20T05:59:59Z'), limit: 500 });
    expect(logs.map((item) => item.id)).toContain(id);
    expect((await app.inject({ method: 'POST', url: '/attendance/recalculate' })).statusCode).toBe(200);
    const daily = (await app.inject({ method: 'GET', url: `/attendance/daily?branchId=${branchId}&from=2026-10-19&to=2026-10-19` })).json();
    expect(daily.flatMap((day: any) => day.result.punches).map((punch: any) => punch.id)).toContain(id);
  });

  it('coordinates concurrent name prefill, synchronization and manual recalculation without changing source logs', async () => {
    const before = await originals();
    const results = await Promise.all([
      sync(), createEmployeeNames(database).populateMissing(),
      app.inject({ method: 'POST', url: '/attendance/recalculate' }),
      app.inject({ method: 'POST', url: '/attendance/recalculate' }),
    ]);
    expect(results[2].statusCode).toBe(200);
    expect(results[3].statusCode).toBe(200);
    expect(await originals()).toEqual(before);
  });
});
