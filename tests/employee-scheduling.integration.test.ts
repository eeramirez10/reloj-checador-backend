import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/main.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import type { EmployeeScheduleInput } from '../src/domain/entities/employee-scheduling.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;
const date = '2026-10-20';

integration('employee scheduling, inheritance and canonical movements', () => {
  const schema = `test_employee_schedule_${randomUUID().replaceAll('-', '')}`;
  let admin: Database;
  let database: Database;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let branchId: string;
  let deviceId: string;
  let employeeId: string;
  let specialId: string;
  const baseSettings = { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30', mealEnabled: false,
    mealStart: '14:00', mealEnd: '15:00', mealDurationMinutes: 60, mealMode: 'individual', recognitionMarginMinutes: 30 };
  const input: EmployeeScheduleInput = { effectiveFrom: date, workHours: null,
    meal: { enabled: true, startTime: '15:00', endTime: '15:00', durationMinutes: 60 }, recognitionMarginMinutes: 30, expectedVersionId: null };

  async function scheduling(id: string) {
    const response = await app.inject({ method: 'GET', url: `/employees/${id}/scheduling` });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
  async function daily(id: string) {
    const response = await app.inject({ method: 'GET', url: `/attendance/daily?from=${date}&to=${date}&subjectId=${id}` });
    expect(response.statusCode).toBe(200);
    return response.json()[0];
  }

  beforeAll(async () => {
    admin = new Database(connection!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(url.toString());
    await runMigrations(database);
    const events = [
      ...['14:40:22','21:16:53','21:57:29','23:33:29'].map((time,index) => ({ deviceLogId: `3039-${index}`, userId: '3039',
        occurredAt: new Date(`${date}T${time}Z`), punchState: index === 3 ? 1 : 0, raw: { original: true } })),
      ...['15:00:00','20:00:00','21:00:00','00:00:00'].map((time,index) => ({ deviceLogId: `3040-${index}`, userId: '3040',
        occurredAt: new Date(`${index === 3 ? '2026-10-21' : date}T${time}Z`), punchState: index === 3 ? 0 : 1, raw: { original: true } })),
    ];
    ({ app } = await buildApp({ database, clients: { getClient: () => ({ testConnection: async () => ({ raw: {} }),
      getUsers: async () => [{ userId: '3039', name: 'Erick Prueba', raw: {} }, { userId: '3040', name: 'Alma Prueba', raw: {} }],
      getAttendance: async () => events,
    }) } }));
    branchId = (await app.inject({ method: 'POST', url: '/branches', payload: { name: 'México de prueba' } })).json().id;
    expect((await app.inject({ method: 'POST', url: '/work-schedules', payload: {
      branchId, name: 'Jornada base', effectiveFrom: '2026-01-01', isDefault: true, settings: baseSettings,
    } })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: `/branches/${branchId}/policies`, payload: { effectiveFrom: '2026-01-01', settings: {
      entryToleranceMinutes: 15, mealToleranceMinutes: 15, entryAllowedTardies: 3, mealAllowedTardies: 3,
      accumulationMode: 'first_lateness', accumulationDays: 30,
    } } })).statusCode).toBe(201);
    deviceId = (await app.inject({ method: 'POST', url: '/devices', payload: { name: 'Reloj', ipAddress: '127.0.0.20', branchId } })).json().id;
    expect((await app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-users` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` })).statusCode).toBe(200);
    const users = (await app.inject({ method: 'GET', url: `/users?deviceId=${deviceId}` })).json();
    employeeId = users.find((user: { userId: string }) => user.userId === '3039').employeeId;
    specialId = users.find((user: { userId: string }) => user.userId === '3040').employeeId;
  }, 30_000);

  afterAll(async () => {
    await app?.close(); await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  it('starts at the first attendance date with inherited work hours and an unconfigured individual meal', async () => {
    const view = await scheduling(employeeId);
    expect(view.firstAttendanceDate).toBe(date);
    expect(view.latestVersionId).toBeNull();
    expect(view.resolved.settings).toMatchObject({ entryTime: '08:30', exitTime: '17:30', mealPending: true, recognitionMarginMinutes: 30 });
    expect((await daily(employeeId)).result).toMatchObject({ status: 'unconfigured', mealConfigured: false });
  });

  it('atomically saves profile and meal, preserving raw modes while classifying 3039 and its summary', async () => {
    const original = (await database.query('SELECT to_jsonb(a) AS record FROM attendance_logs a WHERE user_id=$1 ORDER BY id', ['3039'])).rows;
    const response = await app.inject({ method: 'PATCH', url: `/employees/${employeeId}`, payload: { firstName: 'Erick', lastName: 'Prueba', scheduling: input } });
    expect(response.statusCode).toBe(204);
    const day = await daily(employeeId);
    expect(day.result.punches.map((punch: { movement: string }) => punch.movement)).toEqual(['entry','meal_departure','meal_return','exit']);
    expect(day.result.workedMinutes).toBe(493);
    expect(day.result.mealMinutes).toBe(41);
    expect((await scheduling(employeeId)).version.workHours).toBeNull();
    const summary = await app.inject({ method: 'GET', url: `/users/3039/attendance-summary?deviceId=${deviceId}` });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().summaries[0].punches.map((punch: { type: string }) => punch.type)).toEqual(['entry','exit','entry','exit']);
    expect(summary.json().summaries[0]).toMatchObject({ inferred: true, workedMinutes: 493 });
    expect((await database.query('SELECT to_jsonb(a) AS record FROM attendance_logs a WHERE user_id=$1 ORDER BY id', ['3039'])).rows).toEqual(original);
  });

  it('uses the 09:00–18:00 individual workday and its own meal for 3040', async () => {
    const response = await app.inject({ method: 'PUT', url: `/employees/${specialId}/scheduling`, payload: { ...input,
      workHours: { workDays: [1,2,3,4,5], entryTime: '09:00', exitTime: '18:00' },
      meal: { enabled: true, startTime: '14:00', endTime: '14:00', durationMinutes: 60 },
    } });
    expect(response.statusCode).toBe(204);
    const day = await daily(specialId);
    expect(day.result).toMatchObject({ status: 'complete', scheduleSource: 'individual' });
    expect(day.result.incidents).toEqual([]);
    expect(day.result.punches.map((punch: { movement: string }) => punch.movement)).toEqual(['entry','meal_departure','meal_return','exit']);
  });

  it('inherits a backdated base revision without freezing hours in meal-only employee settings', async () => {
    const response = await app.inject({ method: 'POST', url: '/work-schedules', payload: {
      branchId, name: 'Base revisada', effectiveFrom: '2026-01-01', isDefault: true,
      settings: { ...baseSettings, entryTime: '08:45', exitTime: '17:45' },
    } });
    expect(response.statusCode).toBe(201);
    expect((await scheduling(employeeId)).resolved.settings).toMatchObject({ entryTime: '08:45', exitTime: '17:45', mealStart: '15:00' });
    expect((await scheduling(specialId)).resolved.settings).toMatchObject({ entryTime: '09:00', exitTime: '18:00', mealStart: '14:00' });
  });

  it('can return to branch work hours while keeping the individual meal and version history', async () => {
    const view = await scheduling(specialId);
    const response = await app.inject({ method: 'PUT', url: `/employees/${specialId}/scheduling`, payload: {
      ...input, workHours: null, meal: view.version.meal, expectedVersionId: view.latestVersionId,
    } });
    expect(response.statusCode).toBe(204);
    const updated = await scheduling(specialId);
    expect(updated.history).toHaveLength(2);
    expect(updated.resolved.settings).toMatchObject({ entryTime: '08:45', exitTime: '17:45', mealStart: '14:00' });
  });

  it('rolls back profile and status together when meal settings are invalid or the version is stale', async () => {
    const view = await scheduling(employeeId);
    const before = (await app.inject({ method: 'GET', url: `/employees/${employeeId}` })).json();
    const statusCount = (await database.query('SELECT COUNT(*)::int AS count FROM employee_status_events WHERE employee_id=$1', [employeeId])).rows[0].count;
    const invalid = await app.inject({ method: 'PATCH', url: `/employees/${employeeId}`, payload: { firstName: 'Invalid change', isActive: false,
      scheduling: { ...input, expectedVersionId: view.latestVersionId, meal: { enabled: true, startTime: '17:00', endTime: '17:00', durationMinutes: 120 } },
    } });
    expect(invalid.statusCode).toBe(400);
    const stale = await app.inject({ method: 'PATCH', url: `/employees/${employeeId}`, payload: { firstName: 'Stale change', isActive: false,
      scheduling: { ...input, expectedVersionId: null },
    } });
    expect(stale.statusCode).toBe(409);
    const after = (await app.inject({ method: 'GET', url: `/employees/${employeeId}` })).json();
    expect(after.firstName).toBe(before.firstName);
    expect(after.isActive).toBe(true);
    expect((await scheduling(employeeId)).latestVersionId).toBe(view.latestVersionId);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM employee_status_events WHERE employee_id=$1', [employeeId])).rows[0].count).toBe(statusCount);
  });

  it('creates an employee and scheduling atomically and exposes its version history', async () => {
    const before = (await database.query('SELECT COUNT(*)::int AS count FROM employees')).rows[0].count;
    const failed = await app.inject({ method: 'POST', url: '/employees', payload: { firstName: 'No guardar', branchId,
      scheduling: { ...input, meal: { enabled: true, startTime: '17:00', endTime: '17:00', durationMinutes: 120 } },
    } });
    expect(failed.statusCode).toBe(400);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM employees')).rows[0].count).toBe(before);
    const created = await app.inject({ method: 'POST', url: '/employees', payload: { firstName: 'Nueva ficha', branchId, scheduling: input } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await scheduling(id)).history).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/employees/${id}/history` })).json().scheduleEvents).toHaveLength(1);
  });
});
