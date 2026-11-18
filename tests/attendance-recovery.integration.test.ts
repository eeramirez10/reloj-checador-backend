import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from './helpers/build-test-app.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { ExternalServiceError } from '../src/domain/errors/app-error.js';
import { addDays, dateAtLocalTime } from '../src/domain/entities/local-date.js';
import { formatDateTimeInTimeZone } from '../src/domain/entities/attendance-summary.js';
import type { ZktecoAttendanceEvent } from '../src/domain/datasources/device-client.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;

integration('idempotent attendance recovery after a network interruption', () => {
  const schema = `test_recovery_${randomUUID().replaceAll('-', '')}`;
  const zone = 'America/Mexico_City';
  const now = new Date(Date.now() - 2000);
  const today = formatDateTimeInTimeZone(now, zone).slice(0, 10);
  const yesterday = addDays(today, -1);
  const older = addDays(today, -3);
  let admin: Database;
  let database: Database;
  let services: Awaited<ReturnType<typeof buildApp>>;
  let branchId: string;
  let clockNumber = 20;
  const download = vi.fn<() => Promise<ZktecoAttendanceEvent[]>>();

  const event = (id: string, date: Date): ZktecoAttendanceEvent => ({ deviceLogId: id, userId: '515', occurredAt: date,
    verificationType: 1, punchState: 0, raw: { deviceLocalTime: formatDateTimeInTimeZone(date, zone), source: 'recovery-test' } });

  async function createClock(clockBranchId = branchId) {
    const response = await services.app.inject({ method: 'POST', url: '/devices', payload: {
      name: `Recovery clock ${clockNumber}`, ipAddress: `127.4.0.${clockNumber++}`, branchId: clockBranchId, enabled: false,
    } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function sync(deviceId: string, expected = 200, date?: string) {
    const response = await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance`, payload: date ? { date } : {} });
    expect(response.statusCode, response.body).toBe(expected);
    return response.json();
  }

  async function originals(deviceId: string) {
    return (await database.query('SELECT id,to_jsonb(a) AS record FROM attendance_logs a WHERE device_id=$1 ORDER BY id', [deviceId])).rows;
  }

  beforeAll(async () => {
    admin = new Database(connection!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection!); url.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(url.toString()); await runMigrations(database);
    services = await buildApp({ database, clients: { getClient: () => ({ testConnection: async () => ({ raw: {} }), getUsers: async () => [], getAttendance: download }) } });
    branchId = (await services.app.inject({ method: 'POST', url: '/branches', payload: { name: 'Recovery branch', timeZone: zone } })).json().id;
    const configuration = await services.app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: {
      effectiveFrom: addDays(older, -1), workHours: { workDays: [1, 2, 3, 4, 5, 6, 7], entryTime: '08:30', exitTime: '17:30' },
      meal: { mode: 'disabled', startTime: '13:00', endTime: '13:00', durationMinutes: 60 }, recognitionMarginMinutes: 30,
      policy: { entryToleranceMinutes: 15, mealToleranceMinutes: 15, entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 },
    } });
    expect(configuration.statusCode, configuration.body).toBe(201);
  }, 60000);

  afterAll(async () => {
    await services?.app.close(); await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  it('recovers yesterday, today and older source records after reconnecting, preserving identity and cross-midnight routes on replay', async () => {
    const deviceId = await createClock();
    const previous = [event('1', dateAtLocalTime(older, '08:30', zone)), event('2', dateAtLocalTime(older, '17:30', zone))];
    download.mockResolvedValue(previous);
    expect(await sync(deviceId)).toMatchObject({ receivedCount: 2, insertedCount: 2 });
    const before = await originals(deviceId);
    const employeeId = (await database.query('SELECT employee_id FROM device_users WHERE device_id=$1 AND device_user_id=$2', [deviceId, '515'])).rows[0].employee_id;
    await database.query(`INSERT INTO employee_schedule_versions(id,employee_id,effective_from,work_hours,meal,meal_mode,recognition_margin_minutes,overtime_settings)
      VALUES($1,$2,$3::date,NULL,NULL,'inherit',30,$4::jsonb)`, [randomUUID(), employeeId, older,
      JSON.stringify({ enabled: true, workMode: 'route', restEnabled: false, dailyRest: null, additionalRestMinutes: 0 })]);
    download.mockRejectedValueOnce(new ExternalServiceError('El reloj no es accesible en esta red.'));
    await sync(deviceId, 502);
    expect(await originals(deviceId)).toEqual(before);

    const recovered = [event('3', dateAtLocalTime(yesterday, '06:30', zone)), event('4', now)];
    download.mockResolvedValue([...previous, ...recovered]);
    expect(await sync(deviceId)).toMatchObject({ status: 'succeeded', receivedCount: 4, insertedCount: 2 });
    const after = await originals(deviceId);
    expect(after).toHaveLength(4);
    for (const row of before) expect(after.find(item => item.id === row.id)).toEqual(row);
    const card = await services.app.inject({ method: 'GET', url: `/employees/${employeeId}/attendance?from=${yesterday}&to=${today}` });
    expect(card.statusCode, card.body).toBe(200);
    for (const day of card.json().days) {
      expect(day.routes).toHaveLength(1);
      expect(day.routes[0]).toMatchObject({ enteredAt: recovered[0].occurredAt.toISOString(), exitedAt: now.toISOString() });
      expect(day.overtime.status).toBe('calculated');
    }
    expect(await sync(deviceId)).toMatchObject({ receivedCount: 4, insertedCount: 0 });
    expect(await originals(deviceId)).toEqual(after);
    const repeatedCard = await services.app.inject({ method: 'GET', url: `/employees/${employeeId}/attendance?from=${yesterday}&to=${today}` });
    expect(repeatedCard.json()).toEqual(card.json());
    expect((await services.devices.findById(deviceId))!.enabled).toBe(false);
  });

  it('retains saved punches when recalculation fails, reports partial progress and safely recalculates on retry without reinsertion', async () => {
    const deviceId = await createClock();
    const records = [event('1', dateAtLocalTime(yesterday, '08:30', zone)), event('2', now)];
    download.mockResolvedValue(records);
    await database.executeScript(`CREATE FUNCTION fail_recovery_evaluation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'recovery_evaluation_failed'; END $$;
      CREATE TRIGGER fail_recovery_evaluation BEFORE INSERT OR UPDATE ON attendance_evaluations FOR EACH ROW EXECUTE FUNCTION fail_recovery_evaluation();`);
    try { await sync(deviceId, 500); }
    finally { await database.executeScript('DROP TRIGGER fail_recovery_evaluation ON attendance_evaluations; DROP FUNCTION fail_recovery_evaluation();'); }
    const saved = await originals(deviceId);
    expect(saved).toHaveLength(2);
    const failed = await services.app.inject({ method: 'GET', url: `/sync-runs?deviceId=${deviceId}` });
    expect(failed.json()[0]).toMatchObject({ status: 'failed', receivedCount: 2, insertedCount: 2 });
    expect(await sync(deviceId)).toMatchObject({ status: 'succeeded', receivedCount: 2, insertedCount: 0 });
    expect(await originals(deviceId)).toEqual(saved);
    const days = await services.app.inject({ method: 'GET', url: `/attendance/daily?branchId=${branchId}&from=${yesterday}&to=${today}` });
    expect(days.json().some((day: any) => day.result.punches.some((punch: any) => saved.some(record => record.id === punch.id)))).toBe(true);
  });

  it('rejects an overlapping manual recovery while a clock is downloading and releases the lock after completion', async () => {
    const deviceId = await createClock();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    download.mockImplementationOnce(async () => { entered(); await blocked; return [event('1', now)]; });
    const first = sync(deviceId);
    await started;
    try { await sync(deviceId, 409); } finally { release(); }
    expect(await first).toMatchObject({ receivedCount: 1, insertedCount: 1 });
    download.mockResolvedValue([event('1', now)]);
    expect(await sync(deviceId)).toMatchObject({ receivedCount: 1, insertedCount: 0 });
    expect(await originals(deviceId)).toHaveLength(1);
  });

  it('recovers only the requested local day including midnight boundaries, without creating users from other dates or duplicating originals', async () => {
    const deviceId = await createClock();
    const previous = event('older', dateAtLocalTime(older, '08:30', zone));
    download.mockResolvedValue([previous]);
    await sync(deviceId);
    const before = await originals(deviceId);
    const start = dateAtLocalTime(yesterday, '00:00', zone);
    const end = dateAtLocalTime(today, '00:00', zone);
    const selected = [event('start', start), event('middle', dateAtLocalTime(yesterday, '12:00', zone)), event('end', new Date(end.getTime() - 1))];
    download.mockResolvedValue([previous, { ...event('before', new Date(start.getTime() - 1)), userId: 'outside-before' }, ...selected,
      { ...event('after', end), userId: 'outside-after' }]);
    expect(await sync(deviceId, 200, yesterday)).toMatchObject({ date: yesterday, timeZone: zone, receivedCount: 3, insertedCount: 3 });
    const after = await originals(deviceId);
    expect(after).toHaveLength(4);
    expect(after.find(row => row.id === before[0].id)).toEqual(before[0]);
    const savedTimes = (await database.query('SELECT occurred_at FROM attendance_logs WHERE device_id=$1 AND device_log_id<>$2 ORDER BY occurred_at', [deviceId, 'older'])).rows;
    expect(savedTimes.map(row => row.occurred_at.toISOString())).toEqual(selected.map(row => row.occurredAt.toISOString()));
    expect((await database.query('SELECT device_user_id FROM device_users WHERE device_id=$1', [deviceId])).rows.map(row => row.device_user_id)).toEqual(['515']);
    expect(await sync(deviceId, 200, yesterday)).toMatchObject({ receivedCount: 3, insertedCount: 0 });
    expect(await originals(deviceId)).toEqual(after);
    download.mockResolvedValue([previous]);
    expect(await sync(deviceId, 200, yesterday)).toMatchObject({ receivedCount: 0, insertedCount: 0 });
    expect(await originals(deviceId)).toEqual(after);
  });

  it('interprets the same selected date in each clock timezone instead of using UTC or the browser timezone', async () => {
    const mexicoClock = await createClock();
    const cancunBranch = (await services.app.inject({ method: 'POST', url: '/branches', payload: { name: 'Recovery Cancun', timeZone: 'America/Cancun' } })).json().id;
    const cancunClock = await createClock(cancunBranch);
    const records = [event('near-midnight', dateAtLocalTime(older, '23:30', zone))];
    download.mockResolvedValue(records);
    expect(await sync(mexicoClock, 200, older)).toMatchObject({ date: older, timeZone: zone, receivedCount: 1, insertedCount: 1 });
    expect(await sync(cancunClock, 200, older)).toMatchObject({ date: older, timeZone: 'America/Cancun', receivedCount: 0, insertedCount: 0 });
    expect(await originals(cancunClock)).toHaveLength(0);
    expect(await sync(cancunClock, 200, addDays(older, 1))).toMatchObject({ receivedCount: 1, insertedCount: 1 });
    expect(await sync(cancunClock, 200, addDays(older, 1))).toMatchObject({ receivedCount: 1, insertedCount: 0 });
  });

  it('rejects invalid dates and unexpected filters before contacting the clock or starting a run', async () => {
    const deviceId = await createClock();
    const calls = download.mock.calls.length;
    for (const date of ['2026-02-30', '2026-13-01', '17/11/2026', '', 42, null]) {
      const response = await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance`, payload: { date } });
      expect(response.statusCode, response.body).toBe(400);
    }
    const unexpected = await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance`, payload: { date: yesterday, from: older } });
    expect(unexpected.statusCode, unexpected.body).toBe(400);
    expect(download.mock.calls.length).toBe(calls);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM sync_runs WHERE device_id=$1', [deviceId])).rows[0].count).toBe(0);
  });

  it('recalculates a cross-midnight route when its missing previous day is recovered later, keeping the already stored return intact', async () => {
    const deviceId = await createClock();
    const previous = [event('older-entry', dateAtLocalTime(older, '08:30', zone)), event('older-exit', dateAtLocalTime(older, '17:30', zone))];
    download.mockResolvedValue(previous);
    await sync(deviceId);
    const employeeId = (await database.query('SELECT employee_id FROM device_users WHERE device_id=$1 AND device_user_id=$2', [deviceId, '515'])).rows[0].employee_id;
    await database.query(`INSERT INTO employee_schedule_versions(id,employee_id,effective_from,work_hours,meal,meal_mode,recognition_margin_minutes,overtime_settings)
      VALUES($1,$2,$3::date,NULL,NULL,'inherit',30,$4::jsonb)`, [randomUUID(), employeeId, older,
      JSON.stringify({ enabled: true, workMode: 'route', restEnabled: false, dailyRest: null, additionalRestMinutes: 0 })]);
    const route = [event('route-entry', dateAtLocalTime(yesterday, '06:30', zone)), event('route-return', now)];
    download.mockResolvedValue([...previous, ...route]);
    expect(await sync(deviceId, 200, today)).toMatchObject({ receivedCount: 1, insertedCount: 1 });
    const returnRecord = (await originals(deviceId)).find(row => row.record.device_log_id === 'route-return');
    expect(await sync(deviceId, 200, yesterday)).toMatchObject({ receivedCount: 1, insertedCount: 1 });
    expect((await originals(deviceId)).find(row => row.id === returnRecord!.id)).toEqual(returnRecord);
    const card = await services.app.inject({ method: 'GET', url: `/employees/${employeeId}/attendance?from=${yesterday}&to=${today}` });
    expect(card.statusCode, card.body).toBe(200);
    for (const day of card.json().days) {
      expect(day.overtime.status).toBe('calculated');
      expect(day.routes).toHaveLength(1);
      expect(day.routes[0]).toMatchObject({ enteredAt: route[0].occurredAt.toISOString(), exitedAt: now.toISOString() });
    }
    const saved = await originals(deviceId);
    for (const date of [yesterday, today]) expect(await sync(deviceId, 200, date)).toMatchObject({ receivedCount: 1, insertedCount: 0 });
    expect(await originals(deviceId)).toEqual(saved);
  });
});
