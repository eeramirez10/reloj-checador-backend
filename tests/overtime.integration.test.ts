import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './helpers/build-test-app.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { dateAtLocalTime } from '../src/domain/entities/local-date.js';
import { DEFAULT_OVERTIME_SETTINGS } from '../src/domain/entities/overtime.js';
import type { EmployeeScheduleInput } from '../src/domain/entities/employee-scheduling.js';
import type { OvertimeReport } from '../src/domain/entities/overtime-report.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;
const zone = 'America/Mexico_City';
const date = '2026-10-19';
const overtime = { ...DEFAULT_OVERTIME_SETTINGS, enabled: true };
const configuration = { effectiveFrom: '2026-01-01', workHours: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30' },
  meal: { mode: 'disabled', startTime: '13:00', endTime: '13:00', durationMinutes: 60 }, recognitionMarginMinutes: 30,
  policy: { entryToleranceMinutes: 15, mealToleranceMinutes: 15, entryAllowedTardies: 3, mealAllowedTardies: 3,
    accumulationMode: 'first_lateness', accumulationDays: 30, entryRepeatWindowMinutes: 20 } };

integration('overtime settings, route lifecycle and reports in PostgreSQL', () => {
  const schema = `test_overtime_${randomUUID().replaceAll('-', '')}`;
  let admin: Database;
  let database: Database;
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let branchId: string;
  let deviceId: string;
  let routeId: string;
  let dailyId: string;
  let emptyId: string;
  let inactiveId: string;
  let configurationId: string;
  let events: Array<{ deviceLogId: string; userId: string; occurredAt: Date; punchState: number; raw: object }>;
  const input: EmployeeScheduleInput = { effectiveFrom: date, workHours: null, meal: null, mealMode: 'inherit', recognitionMarginMinutes: 30, overtime };

  async function get(path: string) {
    const response = await app.inject({ method: 'GET', url: path });
    expect(response.statusCode).toBe(200);
    return response.json();
  }
  async function daily(id: string) {
    return get(`/attendance/daily?from=${date}&to=2026-10-21&subjectId=${id}`);
  }
  async function report(from = date, to = '2026-10-21', status = 'active', page = 1): Promise<OvertimeReport> {
    return get(`/attendance/overtime?branchId=${branchId}&employeeStatus=${status}&from=${from}&to=${to}&page=${page}&limit=1`);
  }
  async function sources() {
    const data: Record<string, unknown> = {};
    for (const table of ['attendance_logs','device_user_photos','device_users','branch_assignments','schedule_assignments','employee_status_events']) {
      data[table] = (await database.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return data;
  }
  async function save(id: string, changes: Partial<EmployeeScheduleInput>) {
    const view = await get(`/employees/${id}/scheduling`);
    const response = await app.inject({ method: 'PATCH', url: `/employees/${id}`, payload: {
      scheduling: { ...input, ...changes, expectedVersionId: view.latestVersionId },
    } });
    expect(response.statusCode).toBe(204);
  }

  beforeAll(async () => {
    admin = new Database(connection!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(scoped.toString());
    await runMigrations(database);
    const event = (userId: string, day: string, time: string) => ({ userId, deviceLogId: `${userId}-${day}-${time}`,
      occurredAt: dateAtLocalTime(day,time,zone), punchState: 0, raw: { original: `${day}-${time}` } });
    events = [event('1',date,'08:50'), ...['05:30','13:00','14:00','21:00'].map((time) => event('2',date,time))];
    ({ app } = await buildApp({ database, clients: { getClient: () => ({ testConnection: async () => ({ raw: {} }),
      getUsers: async () => ['Ana Ruta','Bruno Diario','Carlos Sin Extras','Diana Sin Registros','Eva Inactiva'].map((name,index) => ({ userId: String(index + 1), name, raw: { name } })),
      getAttendance: async () => events,
    }) } }));
    branchId = (await app.inject({ method: 'POST', url: '/branches', payload: { name: 'Sucursal extras' } })).json().id;
    const configured = await app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: configuration });
    expect(configured.statusCode).toBe(201);
    configurationId = configured.json().schedule.configurationId;
    deviceId = (await app.inject({ method: 'POST', url: '/devices', payload: { name: 'Reloj extras', ipAddress: '127.0.0.30', branchId } })).json().id;
    expect((await app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-users` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` })).statusCode).toBe(200);
    const users = await get(`/users?deviceId=${deviceId}`);
    const employee = (userId: string) => users.find((user: { userId: string }) => user.userId === userId).employeeId;
    routeId = employee('1'); dailyId = employee('2'); emptyId = employee('4'); inactiveId = employee('5');
    await database.query(`INSERT INTO device_user_photos (device_id,device_user_id,content_type,image_data) VALUES ($1,'1','image/jpeg',$2)`, [deviceId,Buffer.from([0xff,0xd8,0xff,0xd9])]);
  }, 30000);

  afterAll(async () => {
    await app?.close(); await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  it('enables dated settings atomically, retains personal hours and meal, and leaves an open route pending', async () => {
    const before = await sources();
    await save(routeId,{ overtime: { ...overtime, workMode: 'route', restEnabled: true,
      dailyRest: { startTime: '22:00', endTime: '06:00' }, additionalRestMinutes: 120 } });
    await save(dailyId,{ workHours: { workDays: [1,2,3,4,5], entryTime: '09:00', exitTime: '18:00' }, mealMode: 'individual',
      meal: { enabled: true, startTime: '13:00', endTime: '13:00', durationMinutes: 60 } });
    await save(emptyId,{});
    await save(inactiveId,{});
    expect((await app.inject({ method: 'PATCH', url: `/employees/${inactiveId}`, payload: { isActive: false } })).statusCode).toBe(204);
    const open = await daily(routeId);
    expect(open.length).toBeGreaterThanOrEqual(3);
    expect(open.every((row: any) => row.result.overtime.status === 'pending' && !row.result.exit)).toBe(true);
    expect((await daily(dailyId))[0].result).toMatchObject({ scheduleSource: 'branch', scheduleSettings: { entryTime: '08:30', exitTime: '17:30' }, overtime: { netSeconds: 23400 } });
    const personal = await get(`/employees/${dailyId}`);
    expect(personal.scheduling).toMatchObject({ workHours: { entryTime: '09:00', exitTime: '18:00' }, meal: { startTime: '13:00' }, overtime });
    const after = await sources();
    expect(after.attendance_logs).toEqual(before.attendance_logs);
    expect(after.device_user_photos).toEqual(before.device_user_photos);
    expect(after.device_users).toEqual(before.device_users);
    const latest = await get(`/employees/${dailyId}/scheduling`);
    const rejected = await app.inject({ method: 'PATCH', url: `/employees/${dailyId}`, payload: { firstName: 'Invalid change', isActive: false,
      scheduling: { ...input, overtime: { ...overtime, restEnabled: true }, expectedVersionId: latest.latestVersionId } } });
    expect(rejected.statusCode).toBe(400);
    expect((await get(`/employees/${dailyId}`)).isActive).toBe(true);
    expect((await app.inject({ method: 'PUT', url: `/employees/${dailyId}/scheduling`, payload: { ...input, expectedVersionId: null } })).statusCode).toBe(409);
    expect((await get(`/employees/${dailyId}/history`)).scheduleEvents[0].overtime.enabled).toBe(true);
  }, 30000);

  it('closes a multi-day route on sync, retains IDs and returns derived days, photos and a summary for a date without punches', async () => {
    const existing = (await database.query('SELECT id FROM attendance_evaluations WHERE subject_id=$1 ORDER BY date', [routeId])).rows;
    events = [...events,{ userId: '1', deviceLogId: 'route-return', occurredAt: dateAtLocalTime('2026-10-21','21:00',zone), punchState: 0, raw: { original: 'return' } }];
    expect((await app.inject({ method: 'POST', url: `/devices/${deviceId}/sync-attendance` })).statusCode).toBe(200);
    const closed = await daily(routeId);
    expect(closed).toHaveLength(3);
    expect(closed.reduce((sum: number,row: any) => sum + row.result.overtime.netSeconds,0)).toBe(55800);
    expect(closed.reduce((sum: number,row: any) => sum + row.result.overtime.additionalRestSeconds,0)).toBe(7200);
    const middle = closed.find((row: any) => row.date === '2026-10-20');
    expect(middle.result.punches).toEqual([]);
    expect(middle.photo).toMatchObject({ deviceId, userId: '1', hasPhoto: true });
    expect(closed.flatMap((row: any) => row.result.incidents)).toEqual([expect.objectContaining({ kind: 'arrival', minutes: 20 })]);
    expect((await database.query('SELECT id FROM attendance_evaluations WHERE subject_id=$1 ORDER BY date', [routeId])).rows.slice(0,3)).toEqual(existing.slice(0,3));
    const from = dateAtLocalTime('2026-10-20','00:00',zone).toISOString();
    const to = new Date(dateAtLocalTime('2026-10-21','00:00',zone).getTime() - 1).toISOString();
    const summary = await get(`/users/1/attendance-summary?deviceId=${deviceId}&from=${from}&to=${to}`);
    expect(summary.summaries).toHaveLength(1);
    expect(summary.summaries[0]).toMatchObject({ date: '2026-10-20', punches: [], sessions: [expect.objectContaining({ inferredFromRoute: true })] });
    const card = await get(`/employees/${routeId}/attendance?from=${date}&to=2026-10-21`);
    expect(card.summary.recordedDays).toBe(3);
    expect(card.summary.earlyExits).toBe(0);
    expect(card.days[2].arrivalDelayMinutes).toBeNull();
  }, 30000);

  it('keeps global totals across pages, excludes disabled staff and never reapplies route rest for a partial period', async () => {
    const before = await sources();
    const first = await report();
    expect(first).toMatchObject({ totalEmployees: 3, totalPages: 3, pageSize: 1, totals: { netSeconds: 79200, pendingDays: 0, noRecordDays: 5 } });
    expect(first.employees[0].employee.id).toBe(routeId);
    const second = await report(date,'2026-10-21','active',2);
    expect(second.employees[0].employee.id).toBe(dailyId);
    expect(second.totals).toEqual(first.totals);
    const middle = await report('2026-10-20','2026-10-20');
    const day = first.employees[0].days.find((item) => item.date === '2026-10-20')!;
    expect(middle.employees[0].days[0].overtime).toEqual(day.overtime);
    const inactive = await report(date,'2026-10-21','inactive');
    expect(inactive.employees.map((item) => item.employee.id)).toEqual([inactiveId]);
    expect((await app.inject({ method: 'GET', url: '/attendance/overtime' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/attendance/overtime?branchId=${branchId}&employeeStatus=active&from=2026-02-30&to=2026-10-21` })).statusCode).toBe(400);
    expect(await sources()).toEqual(before);
  }, 30000);

  it('exports all eligible employees in a read-only snapshot beyond pagination, with the same days and totals as the on-screen report', async () => {
    const before = await sources();
    const evaluations = (await database.query('SELECT to_jsonb(e) AS record FROM attendance_evaluations e ORDER BY id')).rows;
    const path = `/attendance/overtime/export?branchId=${branchId}&employeeStatus=active&from=${date}&to=2026-10-21`;
    const exported = await get(path);
    const first = await report();
    expect(exported.totalEmployees).toBe(3);
    expect(exported.employees).toHaveLength(3);
    expect(exported.totals).toEqual(first.totals);
    expect(exported.employees[0]).toEqual(first.employees[0]);
    expect(exported.employees[1]).toEqual((await report(date,'2026-10-21','active',2)).employees[0]);
    expect(exported.employees[2]).toEqual((await report(date,'2026-10-21','active',3)).employees[0]);
    expect(Number.isFinite(Date.parse(exported.generatedAt))).toBe(true);
    expect(exported).not.toHaveProperty('page');
    expect((await get(`/attendance/overtime/export?branchId=${branchId}&employeeStatus=inactive&from=${date}&to=2026-10-21`)).employees.map((item: any) => item.employee.id)).toEqual([inactiveId]);
    expect((await app.inject({ method: 'GET', url: `${path}&page=2&limit=1` })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/attendance/overtime/export' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/attendance/overtime/export?branchId=${randomUUID()}&employeeStatus=active&from=${date}&to=2026-10-21` })).statusCode).toBe(404);
    expect(await sources()).toEqual(before);
    expect((await database.query('SELECT to_jsonb(e) AS record FROM attendance_evaluations e ORDER BY id')).rows).toEqual(evaluations);
  }, 30000);

  it('preserves extras through legacy edits and assignment, and recalculates branch revisions and deletion without altering sources', async () => {
    const before = await sources();
    const view = await get(`/employees/${dailyId}/scheduling`);
    const legacy = { ...input, overtime: undefined, expectedVersionId: view.latestVersionId };
    expect((await app.inject({ method: 'PUT', url: `/employees/${dailyId}/scheduling`, payload: legacy })).statusCode).toBe(204);
    expect((await get(`/employees/${dailyId}/scheduling`)).version.overtime).toEqual(overtime);
    expect((await app.inject({ method: 'POST', url: '/organization/assignments', payload: { employeeIds: [dailyId], branchId, effectiveFrom: date } })).statusCode).toBe(204);
    expect((await get(`/employees/${dailyId}/scheduling`)).version.overtime).toEqual(overtime);
    const configured = await app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: {
      ...configuration, effectiveFrom: '2026-10-20', workHours: { ...configuration.workHours, exitTime: '18:30' },
    } });
    expect(configured.statusCode).toBe(201);
    const revision = configured.json();
    expect((await report()).employees[0].totals.netSeconds).toBe(48600);
    expect((await app.inject({ method: 'DELETE', url: `/branches/${branchId}/configuration/versions/${revision.schedule.configurationId}` })).statusCode).toBe(200);
    expect((await report()).employees[0].totals.netSeconds).toBe(55800);
    expect((await app.inject({ method: 'DELETE', url: `/branches/${branchId}/configuration/versions/${configurationId}` })).statusCode).toBe(200);
    const pending = await report();
    expect(pending.employees[0].totals).toMatchObject({ netSeconds: 0, pendingDays: 3 });
    const after = await sources();
    for (const table of ['attendance_logs','device_user_photos','device_users','employee_status_events']) expect(after[table]).toEqual(before[table]);
  }, 30000);
});
