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

  async function createClock() {
    const response = await services.app.inject({ method: 'POST', url: '/devices', payload: {
      name: `Recovery clock ${clockNumber}`, ipAddress: `127.4.0.${clockNumber++}`, branchId, enabled: false,
    } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json().id as string;
  }

  async function sync(deviceId: string, expected = 200) {
    const response = await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance`, payload: {} });
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
});
