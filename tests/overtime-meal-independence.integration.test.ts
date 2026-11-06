import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './helpers/build-test-app.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { dateAtLocalTime } from '../src/domain/entities/local-date.js';
import { DEFAULT_OVERTIME_SETTINGS } from '../src/domain/entities/overtime.js';
import type { OvertimeReport } from '../src/domain/entities/overtime-report.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;
const overtime = { ...DEFAULT_OVERTIME_SETTINGS, enabled: true };
const zone = 'America/Mexico_City';

integration('overtime with incomplete meal records', () => {
  const schema = `test_meal_overtime_${randomUUID().replaceAll('-', '')}`;
  let admin: Database; let database: Database; let services: Awaited<ReturnType<typeof buildApp>>;
  let branchId: string; let deviceId: string; let dailyId: string; let routeId: string; let disabledId: string;

  async function get(path: string) {
    const response = await services.app.inject({ method: 'GET', url: path });
    expect(response.statusCode, response.body).toBe(200); return response.json();
  }
  async function sourceRecords() {
    const records: Record<string, unknown> = {};
    for (const table of ['attendance_logs','employees','device_users','device_user_photos','branch_assignments']) {
      records[table] = (await database.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return records;
  }
  async function report(): Promise<OvertimeReport> {
    return get(`/attendance/overtime?branchId=${branchId}&employeeStatus=active&from=2026-10-19&to=2026-10-22&limit=10`);
  }
  async function configure(id: string, settings = overtime) {
    const current = await get(`/employees/${id}/scheduling`);
    const response = await services.app.inject({ method: 'PUT', url: `/employees/${id}/scheduling`, payload: {
      effectiveFrom: '2026-10-19', workHours: null, meal: null, mealMode: 'inherit', recognitionMarginMinutes: 30,
      recognitionMarginInherited: true, expectedVersionId: current.latestVersionId, overtime: settings,
    } });
    expect(response.statusCode, response.body).toBe(204);
  }

  beforeAll(async () => {
    admin = new Database(connection!); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!); scoped.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(scoped.toString()); await runMigrations(database);
    const event = (userId: string, date: string, time: string) => ({ userId, deviceLogId: `${userId}-${date}-${time}`,
      occurredAt: dateAtLocalTime(date, time, zone), raw: { original: `${userId}-${date}-${time}` } });
    const events = [
      ...['08:28','20:39'].map((time) => event('517','2026-10-19',time)),
      ...['08:28','13:00','20:39'].map((time) => event('517','2026-10-20',time)),
      ...['08:28','17:00','18:00','20:39'].map((time) => event('517','2026-10-21',time)),
      event('517','2026-10-22','08:28'),
      event('515','2026-10-19','08:30'), event('515','2026-10-20','21:00'),
      event('518','2026-10-19','08:28'), event('518','2026-10-19','20:39'),
    ];
    services = await buildApp({ database, clients: { getClient: () => ({ testConnection: async () => ({ raw: {} }),
      getAttendance: async () => events, getUsers: async () => ['515','517','518'].map((userId) => ({ userId, name: `Persona ${userId}`, raw: { userId } })),
    }) } });
    branchId = (await services.app.inject({ method: 'POST', url: '/branches', payload: { name: 'Querétaro prueba' } })).json().id;
    expect((await services.app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: {
      effectiveFrom: '2026-01-01', workHours: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30' },
      meal: { mode: 'automatic', startTime: '13:00', endTime: '13:00', durationMinutes: 60 }, recognitionMarginMinutes: 30,
      policy: { entryToleranceMinutes: 15, mealToleranceMinutes: 15, entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 },
    } })).statusCode).toBe(201);
    deviceId = (await services.app.inject({ method: 'POST', url: '/devices', payload: { name: 'Reloj Querétaro', ipAddress: '127.3.0.17', branchId } })).json().id;
    expect((await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-users` })).statusCode).toBe(200);
    expect((await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` })).statusCode).toBe(200);
    const users = await get(`/users?deviceId=${deviceId}`);
    dailyId = users.find((user: { userId: string }) => user.userId === '517').employeeId;
    routeId = users.find((user: { userId: string }) => user.userId === '515').employeeId;
    disabledId = users.find((user: { userId: string }) => user.userId === '518').employeeId;
    await configure(dailyId); await configure(routeId, { ...overtime, workMode: 'route' });
    await database.query("INSERT INTO device_user_photos (device_id,device_user_id,content_type,image_data) VALUES ($1,'517','image/jpeg',$2)", [deviceId, Buffer.from([0xff,0xd8,0xff,0xd9])]);
  }, 30000);
  afterAll(async () => { await services?.app.close(); await database?.close(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); } });

  it('returns calculated extras alongside incomplete attendance in daily reports, individual and branch cards and overtime totals', async () => {
    const before = await sourceRecords();
    const result = await report();
    const employee = result.employees.find((item) => item.employee.id === dailyId)!;
    expect(employee.totals).toMatchObject({ calculatedDays: 3, pendingDays: 1, grossSeconds: 32580, netSeconds: 32580 });
    for (const day of employee.days.slice(0, 2)) {
      expect(day.status).toBe('incomplete'); expect(day.workedMinutes).toBeNull();
      expect(day.overtime).toMatchObject({ status: 'calculated', beforeSeconds: 120, afterSeconds: 11340, netSeconds: 11460 });
      expect(day.issues.length).toBeGreaterThan(0);
    }
    expect(employee.days[0].missingMovements).toEqual(['meal_departure','meal_return']);
    expect(employee.days[1].missingMovements).toEqual(['meal_return']);
    expect(employee.days[2].overtime).toMatchObject({ status: 'calculated', netSeconds: 9660 });
    expect(employee.days[2].status).toBe('complete');
    expect(employee.days[3].overtime).toMatchObject({ status: 'pending', netSeconds: null });
    expect(result.employees.some((item) => item.employee.id === disabledId)).toBe(false);
    const daily = await get(`/attendance/daily?from=2026-10-19&to=2026-10-19&subjectId=${dailyId}`);
    expect(daily[0].result).toMatchObject({ status: 'incomplete', overtime: { status: 'calculated', netSeconds: 11460 } });
    const card = await get(`/employees/${dailyId}/attendance?from=2026-10-19&to=2026-10-22`);
    expect(card.days).toEqual(employee.days);
    const branch = await get(`/attendance/cards?branchId=${branchId}&employeeStatus=active&from=2026-10-19&to=2026-10-22&limit=10`);
    expect(branch.cards.find((item: { employee: { id: string } }) => item.employee.id === dailyId).days).toEqual(card.days);
    expect(await sourceRecords()).toEqual(before);
  });

  it('applies rest discounts without filling unknown worked hours, keeps routes intact and recalculates idempotently', async () => {
    const before = await sourceRecords(); const previous = await report();
    const route = previous.employees.find((item) => item.employee.id === routeId);
    await configure(dailyId, { ...overtime, restEnabled: true, dailyRest: { startTime: '20:00', endTime: '21:00' }, additionalRestMinutes: 20 });
    const result = await report(); const employee = result.employees.find((item) => item.employee.id === dailyId)!;
    expect(employee.days[0].overtime).toMatchObject({ grossSeconds: 11460, dailyRestSeconds: 2340, additionalRestSeconds: 1200, netSeconds: 7920 });
    expect(employee.days[0].workedMinutes).toBeNull();
    expect(result.employees.find((item) => item.employee.id === routeId)).toEqual(route);
    const ids = (await database.query('SELECT id,subject_id,date FROM attendance_evaluations ORDER BY id')).rows;
    expect((await services.app.inject({ method: 'POST', url: '/attendance/recalculate' })).statusCode).toBe(200);
    expect(await report()).toEqual(result);
    expect((await database.query('SELECT id,subject_id,date FROM attendance_evaluations ORDER BY id')).rows).toEqual(ids);
    expect(await sourceRecords()).toEqual(before);
  });
});
