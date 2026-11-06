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
const policy = { entryToleranceMinutes: 15, mealToleranceMinutes: 15, entryAllowedTardies: 3, mealAllowedTardies: 3,
  accumulationMode: 'first_lateness', accumulationDays: 30, entryRepeatWindowMinutes: 20 };
const configuration = { effectiveFrom: '2026-01-01', workHours: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30' },
  meal: { mode: 'automatic', startTime: '13:00', endTime: '13:00', durationMinutes: 60 }, recognitionMarginMinutes: 30, policy };

integration('dated branch overtime entry and exit margins', () => {
  const schema = `test_branch_overtime_${randomUUID().replaceAll('-', '')}`;
  let admin: Database; let database: Database; let services: Awaited<ReturnType<typeof buildApp>>;
  let branchId: string; let otherBranchId: string; let initialToken: string; let ids: Record<string, string>;

  async function get(path: string) {
    const response = await services.app.inject({ method: 'GET', url: path });
    expect(response.statusCode, response.body).toBe(200); return response.json();
  }
  async function view() { return get(`/branches/${branchId}/configuration`); }
  async function report(branch = branchId): Promise<OvertimeReport> {
    return get(`/attendance/overtime?branchId=${branch}&employeeStatus=active&from=2026-10-19&to=2026-10-22&limit=10`);
  }
  async function originalData() {
    const result: Record<string, unknown> = {};
    for (const table of ['attendance_logs','employees','device_users','device_user_photos','employee_schedule_versions','branch_assignments']) {
      result[table] = (await database.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    result.evaluationIds = (await database.query('SELECT id,subject_id,date FROM attendance_evaluations ORDER BY id')).rows;
    return result;
  }

  beforeAll(async () => {
    admin = new Database(connection!); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!); scoped.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(scoped.toString()); await runMigrations(database);
    services = await buildApp({ database, clients: { getClient: () => ({ testConnection: async () => ({ raw: {} }),
      getUsers: async (device) => (device.branchId === branchId ? ['515','516','517','518'] : ['517']).map((userId) => ({ userId, name: `Persona ${userId}`, raw: { original: userId } })),
      getAttendance: async (device) => ['2026-10-19','2026-10-20','2026-10-21','2026-10-22'].flatMap((date) =>
        (device.branchId === branchId ? ['515','516','517','518'] : ['517']).flatMap((userId) => (userId === '516' ? ['08:00','18:00'] : ['07:00','18:30']).map((time) =>
          ({ userId, deviceLogId: `${userId}-${date}-${time}`, occurredAt: dateAtLocalTime(date,time,'America/Mexico_City'), raw: { original: `${userId}-${date}-${time}` } })))),
    }) } });
    branchId = (await services.app.inject({ method: 'POST', url: '/branches', payload: { name: 'Querétaro margen' } })).json().id;
    otherBranchId = (await services.app.inject({ method: 'POST', url: '/branches', payload: { name: 'México sin margen' } })).json().id;
    ids = {};
    for (const [branch, ip] of [[branchId,'127.4.0.1'],[otherBranchId,'127.4.0.2']]) {
      expect((await services.app.inject({ method: 'POST', url: `/branches/${branch}/configuration`, payload: configuration })).statusCode).toBe(201);
      const deviceId = (await services.app.inject({ method: 'POST', url: '/devices', payload: { name: `Reloj ${ip}`, ipAddress: ip, branchId: branch } })).json().id;
      expect((await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-users` })).statusCode).toBe(200);
      expect((await services.app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` })).statusCode).toBe(200);
      const users = await get(`/users?deviceId=${deviceId}`);
      for (const user of users) {
        const id = user.employeeId; ids[`${branch}:${user.userId}`] = id;
        if (user.userId === '518') continue;
        const response = await services.app.inject({ method: 'PUT', url: `/employees/${id}/scheduling`, payload: {
          effectiveFrom: '2026-01-01', workHours: null, meal: null, mealMode: 'inherit', recognitionMarginMinutes: 30,
          overtime: { ...DEFAULT_OVERTIME_SETTINGS, enabled: true, workMode: user.userId === '515' ? 'route' : 'daily' },
        } });
        expect(response.statusCode, response.body).toBe(204);
      }
    }
    initialToken = (await view()).latestVersionId;
  }, 30000);
  afterAll(async () => { await services?.app.close(); await database?.close(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); } });

  it('saves branch-wide margins with an effective date, recalculates daily and route work, and keeps other branches and disabled employees independent', async () => {
    const before = await originalData();
    const saved = await services.app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: {
      ...configuration, effectiveFrom: '2026-10-20', expectedVersionId: initialToken,
      policy: { ...policy, overtimeEntryMarginMinutes: 30, overtimeExitMarginMinutes: 30 },
    } });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(saved.json().policy.settings).toMatchObject({ overtimeEntryMarginMinutes: 30, overtimeExitMarginMinutes: 30 });
    const result = await report();
    for (const user of ['515','517']) {
      const days = result.employees.find((item) => item.employee.id === ids[`${branchId}:${user}`])!.days;
      expect(days.map((day) => day.overtime.netSeconds)).toEqual([9000,5400,5400,5400]);
      expect(days[0].overtime.entryMarginMinutes).toBe(0);
      expect(days[1].overtime).toMatchObject({ beforeSeconds: 3600, afterSeconds: 1800, entryMarginMinutes: 30, exitMarginMinutes: 30 });
    }
    const boundary = result.employees.find((item) => item.employee.id === ids[`${branchId}:516`])!;
    expect(boundary.days.map((day) => day.overtime.netSeconds)).toEqual([3600,0,0,0]);
    expect(boundary.days[1].missingMovements).toEqual(['meal_departure','meal_return']);
    expect(result.employees.some((item) => item.employee.id === ids[`${branchId}:518`])).toBe(false);
    expect((await report(otherBranchId)).employees[0].days.every((day) => day.overtime.netSeconds === 9000)).toBe(true);
    const exported = await get(`/attendance/overtime/export?branchId=${branchId}&employeeStatus=active&from=2026-10-19&to=2026-10-22`);
    expect(exported.totals).toEqual(result.totals);
    expect(exported.employees.find((item: any) => item.employee.id === ids[`${branchId}:517`]).days[1].overtime.entryMarginMinutes).toBe(30);
    expect(await originalData()).toEqual(before);
  });

  it('rejects invalid values and stale edits without replacing the saved rules', async () => {
    const current = await view();
    for (const invalid of [-1, 241, 0.5]) {
      const response = await services.app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: {
        ...configuration, policy: { ...policy, overtimeEntryMarginMinutes: invalid }, expectedVersionId: current.latestVersionId,
      } });
      expect(response.statusCode).toBe(400);
    }
    expect((await services.app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: { ...configuration, expectedVersionId: initialToken } })).statusCode).toBe(409);
    expect((await view()).latestVersionId).toBe(current.latestVersionId);
  });

  it('preserves margins for older unified and policy-only requests that omit them', async () => {
    const current = await view();
    const saved = await services.app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: {
      ...configuration, effectiveFrom: '2026-10-21', expectedVersionId: current.latestVersionId,
    } });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().policy.settings).toMatchObject({ overtimeEntryMarginMinutes: 30, overtimeExitMarginMinutes: 30 });
    const legacy = await services.app.inject({ method: 'POST', url: `/branches/${branchId}/policies`, payload: { effectiveFrom: '2026-10-22', settings: policy } });
    expect(legacy.statusCode, legacy.body).toBe(201);
    expect(legacy.json().settings).toMatchObject({ overtimeEntryMarginMinutes: 30, overtimeExitMarginMinutes: 30 });
    expect((await report()).employees.find((item) => item.employee.id === ids[`${branchId}:517`])!.days[3].overtime.netSeconds).toBe(5400);
  });

  it('supports explicitly resetting margins to zero and restores the previous dated margins after deleting that version', async () => {
    const before = await originalData(); const current = await view();
    const saved = await services.app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: {
      ...configuration, effectiveFrom: '2026-10-22', expectedVersionId: current.latestVersionId,
      policy: { ...policy, overtimeEntryMarginMinutes: 0, overtimeExitMarginMinutes: 0 },
    } });
    expect(saved.statusCode).toBe(201);
    expect((await report()).employees.find((item) => item.employee.id === ids[`${branchId}:517`])!.days[3].overtime.netSeconds).toBe(9000);
    const version = saved.json();
    const removed = await services.app.inject({ method: 'DELETE', url: `/branches/${branchId}/configuration/versions/${version.policy.configurationId}`,
      payload: { expectedVersionId: version.latestVersionId } });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().history.find((item: any) => item.id === version.policy.configurationId).deletedAt).toBeTruthy();
    expect((await report()).employees.find((item) => item.employee.id === ids[`${branchId}:517`])!.days[3].overtime.netSeconds).toBe(5400);
    expect(await originalData()).toEqual(before);
  });
});
