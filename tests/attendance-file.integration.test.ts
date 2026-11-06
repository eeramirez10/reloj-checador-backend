import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './helpers/build-test-app.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { PrismaAttendanceDatasource } from '../src/infrastructure/datasources/attendance-datasource.js';
import { PrismaDeviceUserDatasource } from '../src/infrastructure/datasources/device-user-datasource.js';
import type { AttendanceFileInput, AttendanceFilePreview, AttendanceFileResult } from '../src/domain/entities/attendance-file.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;
const line = (userId: string, time: string) => `01${userId.padStart(7,'0')}0000019-10-26001${time}B`;

integration('lossless attendance file imports', () => {
  const schema = `test_attendance_file_${randomUUID().replaceAll('-','')}`;
  let admin: Database; let database: Database; let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let branchId: string; let deviceId: string; let source: PrismaAttendanceDatasource;
  const input = (content: string, fileName = 'Talavie.txt'): AttendanceFileInput => ({ branchId, deviceId, content, fileName });
  async function preview(payload: AttendanceFileInput): Promise<AttendanceFilePreview> {
    const response = await app.inject({ method: 'POST', url: '/attendance/imports/preview', payload });
    expect(response.statusCode,response.body).toBe(200); return response.json();
  }
  async function commit(payload: AttendanceFileInput, token?: string) {
    return app.inject({ method: 'POST', url: '/attendance/imports', payload: { ...payload, expectedToken: token ?? (await preview(payload)).token } });
  }
  async function sources() {
    const result: Record<string,unknown> = {};
    for (const table of ['attendance_logs','employees','device_users','device_user_photos','branch_assignments','attendance_file_imports']) {
      result[table] = (await database.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return result;
  }
  beforeAll(async () => {
    admin = new Database(connection!); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection!); url.searchParams.set('options',`-c search_path=${schema}`);
    database = new Database(url.toString()); await runMigrations(database);
    ({ app } = await buildApp({ database }));
    branchId = (await app.inject({ method: 'POST', url: '/branches', payload: { name: 'Cancún', timeZone: 'America/Cancun' } })).json().id;
    expect((await app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: { effectiveFrom: '2026-01-01',
      workHours: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30' }, meal: { mode: 'disabled', startTime: '13:00', endTime: '13:00', durationMinutes: 60 }, recognitionMarginMinutes: 30,
      policy: { entryToleranceMinutes: 15, mealToleranceMinutes: 15, entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 } } })).statusCode).toBe(201);
    deviceId = (await app.inject({ method: 'POST', url: '/devices', payload: { name: 'Cancún', ipAddress: '127.0.0.41', branchId } })).json().id;
    const users = new PrismaDeviceUserDatasource(database);
    for (const userId of ['601','603','000606','608']) await users.upsert(deviceId,{ userId, name: `Persona ${userId}`, raw: { original: true } });
    source = new PrismaAttendanceDatasource(database);
    for (const [userId,time] of [['601','22:58:42'],['603','13:40:05'],['603','13:40:45']]) await source.insertIfNew(deviceId,{ userId, deviceLogId: `${userId}-${time}`,
      occurredAt: new Date(`2026-10-19T${time}Z`), punchState: 0, raw: { original: time } });
    await database.query(`INSERT INTO device_user_photos (device_id,device_user_id,content_type,image_data) VALUES ($1,'601','image/jpeg',$2)`,[deviceId,Buffer.from([255,216,255,217])]);
  },30000);
  afterAll(async () => { await app?.close(); await database?.close(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); } });

  it('previews exact minute matches, ambiguity, padded IDs, duplicate lines and invalid lines without writes', async () => {
    const before = await sources();
    const result = await preview(input([line('601','1758'),line('603','0840'),line('608','0823'),line('608','0823'),'bad',line('606','0841')].join('\r\n')));
    expect(result.summary).toMatchObject({ total: 6, new: 2, existing: 1, duplicate: 1, invalid: 1, ambiguous: 1, unknownUsers: 0 });
    expect(result.rows[0].matchingTimes).toEqual(['2026-10-19 17:58:42']);
    expect(result.rows[2].occurredAt).toBe('2026-10-19T13:23:00.000Z');
    expect(result.rows[5].userId).toBe('000606');
    expect(await sources()).toEqual(before);
  });

  it('registers only new rows, keeps originals and file evidence, recalculates and makes reuploads idempotent', async () => {
    const original = (await database.query('SELECT to_jsonb(t) AS row FROM attendance_logs t ORDER BY id')).rows;
    const payload = input([line('601','1758'),line('608','0823'),line('608','0823'),'bad',line('699','1800')].join('\n'));
    const response = await commit(payload); expect(response.statusCode,response.body).toBe(200);
    const result = response.json<AttendanceFileResult>();
    expect(result).toMatchObject({ insertedCount: 2, recalculated: true, alreadyImported: false, summary: { duplicate: 1, invalid: 1, existing: 1 } });
    const again = await commit(payload,result.token); expect(again.json()).toMatchObject({ id: result.id, alreadyImported: true, insertedCount: 2 });
    expect((await database.query('SELECT COUNT(*)::int AS count FROM attendance_logs')).rows[0].count).toBe(5);
    for (const row of original) expect((await database.query('SELECT to_jsonb(t) AS row FROM attendance_logs t WHERE id=$1',[(row.row as {id:string}).id])).rows[0]).toEqual(row);
    const audit = (await database.query('SELECT original_content,report FROM attendance_file_imports WHERE id=$1',[result.id])).rows[0];
    expect(audit.original_content).toBe(payload.content);
    expect(audit.report.rows[1].rawLine).toBe(line('608','0823'));
    const pending = (await database.query(`SELECT e.identification_status FROM device_users u JOIN employees e ON e.id=u.employee_id WHERE u.device_id=$1 AND u.device_user_id='699'`,[deviceId])).rows[0];
    expect(pending.identification_status).toBe('pending');
    const daily = await app.inject({ method: 'GET', url: `/attendance/daily?branchId=${branchId}&from=2026-10-19&to=2026-10-19` });
    expect(daily.json().some((day: any) => day.result.punches.some((punch: any) => punch.occurredAt === '2026-10-19T13:23:00.000Z'))).toBe(true);
    const history = (await app.inject({ method: 'GET', url: `/attendance/imports?deviceId=${deviceId}` })).json();
    expect(history).toHaveLength(1); expect(history[0].rows).toBeUndefined();
  });

  it('enriches a prior imported event on native synchronization without changing its UUID or adding a duplicate', async () => {
    const before = (await database.query(`SELECT id FROM attendance_logs WHERE device_id=$1 AND user_id='699'`,[deviceId])).rows[0];
    const event = { userId: '699', deviceLogId: 'native-699', occurredAt: new Date('2026-10-19T23:00:37Z'), punchState: 1, raw: { userSn: 'native-699', original: 'native' } };
    expect(await source.insertIfNew(deviceId,event)).toBe(false);
    expect(await source.insertIfNew(deviceId,event)).toBe(false);
    const after = (await database.query(`SELECT id,occurred_at,raw_data FROM attendance_logs WHERE device_id=$1 AND user_id='699'`,[deviceId])).rows;
    expect(after).toHaveLength(1); expect(after[0].id).toBe(before.id);
    expect(after[0].occurred_at).toEqual(event.occurredAt);
    expect(after[0].raw_data.importEvidence.originalLine).toBe(line('699','1800'));
    expect(after[0].raw_data.original).toBe('native');
    expect(await source.insertIfNew(deviceId,{ ...event, deviceLogId: 'second-native-699', occurredAt: new Date('2026-10-19T23:00:52Z') })).toBe(true);
    expect((await preview(input(line('699','1800'),'overlap.txt'))).summary.ambiguous).toBe(1);
  });

  it('detects a stale preview after a native insert and requires the correct source branch', async () => {
    const payload = input(line('608','0855'),'stale.txt'); const checked = await preview(payload);
    await source.insertIfNew(deviceId,{ userId: '608', deviceLogId: 'new-after-preview', occurredAt: new Date('2026-10-19T13:55:12Z'), raw: {} });
    expect((await commit(payload,checked.token)).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/attendance/imports/preview', payload: { ...payload, branchId: randomUUID() } })).statusCode).toBe(400);
  });

  it('rolls back checadas and pending identities when the audit insert fails', async () => {
    const payload = input(line('700','0900'),'rollback.txt'); const checked = await preview(payload); const before = await sources();
    await database.executeScript(`CREATE FUNCTION reject_attendance_file() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced_import_failure'; END $$;
      CREATE TRIGGER reject_attendance_file BEFORE INSERT ON attendance_file_imports FOR EACH ROW EXECUTE FUNCTION reject_attendance_file();`);
    try { expect((await commit(payload,checked.token)).statusCode).toBe(500); expect(await sources()).toEqual(before); }
    finally { await database.executeScript('DROP TRIGGER reject_attendance_file ON attendance_file_imports; DROP FUNCTION reject_attendance_file();'); }
  });

  it('serializes concurrent submissions and deduplicates overlaps from another filename', async () => {
    const payload = input(line('608','1815'),'concurrent.txt'); const checked = await preview(payload);
    const results = await Promise.all([commit(payload,checked.token),commit(payload,checked.token)]);
    expect(results.map((response) => response.statusCode)).toEqual([200,200]);
    expect(results.filter((response) => response.json().alreadyImported)).toHaveLength(1);
    expect((await database.query(`SELECT id FROM attendance_logs WHERE device_id=$1 AND user_id='608' AND occurred_at='2026-10-19T23:15:00Z'`,[deviceId])).rows).toHaveLength(1);
    const overlapping = input(`${line('608','1815')}\n${line('608','1816')}`,'other.txt');
    const next = await commit(overlapping); expect(next.json()).toMatchObject({ insertedCount: 1, summary: { new: 1, existing: 1 } });
  });
});
