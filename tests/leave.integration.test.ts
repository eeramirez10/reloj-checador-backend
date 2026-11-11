import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './helpers/build-test-app.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { dateAtLocalTime } from '../src/domain/entities/local-date.js';
import type { LeaveInput, LeaveRequest } from '../src/domain/entities/leave.js';
import { createHash } from 'node:crypto';
import { ManageLeave } from '../src/domain/use-cases/manage-leave.js';
import { PrismaLeaveRepository } from '../src/infrastructure/repositories/leave-repository.js';
import { buildApp as buildApplication } from '../src/main.js';
import type { AuthPrincipal } from '../src/domain/entities/auth.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;

integration('employee leave requests, vacation accounting and attendance', () => {
  const schema = `test_leave_${randomUUID().replaceAll('-', '')}`;
  let admin: Database; let database: Database; let services: Awaited<ReturnType<typeof buildApp>>;
  let branchId: string; let bossId: string; let employeeId: string; let deviceId: string;
  let absence: LeaveRequest;
  let bossServices: Awaited<ReturnType<typeof buildApplication>>;
  let bossPrincipal: AuthPrincipal;
  async function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, expected = 200) {
    const decision=payload as {action?:string}|undefined;
    const response = await (url.endsWith('/resolve') && decision?.action!=='cancel' ? bossServices : services).app.inject({ method, url, payload });
    expect(response.statusCode, response.body).toBe(expected);
    return response.body ? response.json() : undefined;
  }
  const profile = (id = employeeId) => call('GET', `/employees/${id}/leave-profile`);
  async function configure(id: string, balance = 10, managerId: string | null = bossId, phone: string | null = null) {
    const current = await profile(id);
    return call('PUT', `/employees/${id}/leave-profile`, { managerId, whatsappPhone: phone, vacationBalance: balance,
      expectedVersion: current.version, adjustmentReason: 'Saldo inicial verificado' });
  }
  function input(from: string, to = from, extra: Partial<LeaveInput> = {}): LeaveInput {
    return { employeeId, from, to, kind: 'absence', authorizedTime: null, paid: true, useVacation: false, reason: 'Asunto familiar', ...extra };
  }
  async function create(value: LeaveInput) {
    const preview = await call('POST', '/leave-requests/preview', value);
    return call('POST', '/leave-requests', { input: value, previewToken: preview.token, sourceKey: randomUUID() }, 201) as Promise<LeaveRequest>;
  }
  function resolve(request: LeaveRequest, action = 'approve', comments = '') {
    return call('POST', `/leave-requests/${request.id}/resolve`, { action, expectedVersion: request.version, comments });
  }
  const card = (from: string, to = from) => call('GET', `/employees/${employeeId}/attendance?from=${from}&to=${to}`);

  beforeAll(async () => {
    admin = new Database(connection!); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!); scoped.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(scoped.toString()); await runMigrations(database);
    services = await buildApp({ database, clients: { getClient: () => ({ testConnection: async () => ({ raw: {} }),
      getUsers: async () => [{ userId: '42', name: 'Original del reloj', raw: {} }],
      getAttendance: async () => ['2026-10-12','2026-10-13','2026-10-14','2026-10-15'].flatMap((date) =>
        (date === '2026-10-14' ? ['08:30','12:00'] : date === '2026-10-15' ? ['07:00','18:30'] : ['10:20','17:30']).map((time) =>
          ({ userId: '42', deviceLogId: `${date}-${time}`, occurredAt: dateAtLocalTime(date, time, 'America/Mexico_City'), raw: { source: 'original' } }))),
    }) } });
    branchId = (await call('POST', '/branches', { name: 'Sucursal permisos' }, 201)).id;
    await call('POST', `/branches/${branchId}/configuration`, { effectiveFrom: '2026-01-01',
      workHours: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30' },
      meal: { mode: 'disabled', startTime: '13:00', endTime: '13:00', durationMinutes: 60 }, recognitionMarginMinutes: 30,
      policy: { entryToleranceMinutes: 5, mealToleranceMinutes: 5, entryAllowedTardies: 0, mealAllowedTardies: 0,
        accumulationMode: 'calendar_month', accumulationDays: 30, overtimeEntryMarginMinutes: 30, overtimeExitMarginMinutes: 30 } }, 201);
    bossId = (await call('POST', '/employees', { firstName: 'Jefa', branchId }, 201)).id;
    employeeId = (await call('POST', '/employees', { firstName: 'Solicitante', branchId }, 201)).id;
    deviceId = (await call('POST', '/devices', { name: 'Reloj permisos', ipAddress: '127.6.0.1', branchId }, 201)).id;
    await call('POST', `/devices/${deviceId}/sync-users`);
    const clock = (await call('GET', `/users?deviceId=${deviceId}`))[0];
    await call('POST', `/employees/${clock.employeeId}/identify`, { targetEmployeeId: employeeId });
    await database.query("UPDATE employees SET hire_date='2026-01-01' WHERE id=ANY($1::uuid[])", [[bossId, employeeId]]);
    await database.query("UPDATE branch_assignments SET effective_from='2026-01-01' WHERE employee_id=ANY($1::uuid[])", [[bossId, employeeId]]);
    await call('POST', `/devices/${deviceId}/sync-attendance`);
    await configure(bossId, 0, null, '+525555555551');
    await configure(employeeId, 10, bossId, '+525555555552');
    bossPrincipal = { id: randomUUID(),username: 'test-boss',name: 'Jefa',role: 'employee',employeeId: bossId,branchIds: [],isActive: true,mustChangePassword: false,version: 1,sessionHash: 'test',csrfToken: 'test' };
    await database.query("INSERT INTO auth_accounts(id,username,name,password_hash,role,employee_id,must_change_password) VALUES($1,'test-boss','Jefa','test-only','employee',$2,FALSE)",[bossPrincipal.id,bossId]);
    bossServices = await buildApplication({ database,authentication: { testPrincipal: bossPrincipal } });
  }, 30000);
  afterAll(async () => { await bossServices?.app.close(); await services?.app.close(); await database?.close(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); } });

  it('configures a direct manager, validates hierarchy, phone uniqueness and stale vacation edits', async () => {
    const current = await profile();
    expect(current.vacationBalance).toBe(10); expect(current.movements).toHaveLength(1);
    const value = { managerId: employeeId, whatsappPhone: null, vacationBalance: 10, expectedVersion: current.version, adjustmentReason: '' };
    await call('PUT', `/employees/${employeeId}/leave-profile`, value, 400);
    await call('PUT', `/employees/${employeeId}/leave-profile`, { ...value, managerId: bossId, expectedVersion: 0 }, 409);
    await call('PUT', `/employees/${employeeId}/leave-profile`, { ...value, managerId: bossId, whatsappPhone: '555123' }, 400);
    await call('PUT', `/employees/${employeeId}/leave-profile`, { ...value, managerId: bossId, whatsappPhone: '+525555555551' }, 409);
    const boss = await profile(bossId);
    await call('PUT', `/employees/${bossId}/leave-profile`, { ...value, managerId: employeeId, expectedVersion: boss.version, vacationBalance: 0 }, 400);
  });

  it('previews only working days, creates pending requests idempotently and persists the intended WhatsApp recipient', async () => {
    const value = input('2026-10-16', '2026-10-19', { useVacation: true });
    const preview = await call('POST', '/leave-requests/preview', value);
    expect(preview.details.days.map((day: any) => day.date)).toEqual(['2026-10-16','2026-10-19']);
    expect(preview.vacationDays).toBe(2);
    const payload = { input: value, previewToken: preview.token, sourceKey: randomUUID() };
    absence = await call('POST', '/leave-requests', payload, 201);
    expect((await call('POST', '/leave-requests', payload, 201)).id).toBe(absence.id);
    expect((await profile()).vacationBalance).toBe(10);
    const detail = await call('GET', `/leave-requests/${absence.id}`);
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({ kind: 'created', recipientEmployeeId: bossId, recipientPhone: '+525555555551', notificationStatus: 'awaiting_configuration' });
    await call('POST', '/leave-requests/preview', value, 409);
    await call('POST', '/leave-requests/preview', input('2026-10-17', '2026-10-18'), 400);
    await call('POST', '/leave-requests/preview', input('2026-10-20', '2026-10-20', { paid: false, useVacation: true }), 400);
  });

  it('approves atomically once, accounts for vacation days and includes authorized days without punches in all attendance views', async () => {
    const sources = (await database.query('SELECT id,event_key,raw_data,occurred_at FROM attendance_logs ORDER BY id')).rows;
    const payload = { action: 'approve', expectedVersion: absence.version, comments: 'Autorizado' };
    const responses = await Promise.all([bossServices.app.inject({ method: 'POST', url: `/leave-requests/${absence.id}/resolve`, payload }), bossServices.app.inject({ method: 'POST', url: `/leave-requests/${absence.id}/resolve`, payload })]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200,409]);
    absence = responses.find((response) => response.statusCode === 200)!.json();
    expect((await profile()).vacationBalance).toBe(8);
    const attendance = await card('2026-10-16', '2026-10-19');
    expect(attendance.days.map((day: any) => day.status)).toEqual(['authorized_absence','day_off','day_off','authorized_absence']);
    expect(attendance.summary).toMatchObject({ authorizedAbsenceDays: 2, daysWithoutRecords: 0, workedMinutes: 0, recordedDays: 0 });
    expect(attendance.days[0]).toMatchObject({ punches: [], workedMinutes: null, entry: null, exit: null });
    const daily = await call('GET', '/attendance/daily?from=2026-10-16&to=2026-10-19');
    expect(daily.filter((day: any) => day.employeeId === employeeId).map((day: any) => day.result.status)).toEqual(['authorized_absence','authorized_absence']);
    const cards = await call('GET', `/attendance/cards/export?branchId=${branchId}&employeeStatus=active&from=2026-10-16&to=2026-10-19`);
    expect(cards.cards.find((item: any) => item.employee.id === employeeId).summary.authorizedAbsenceDays).toBe(2);
    expect((await database.query('SELECT id,event_key,raw_data,occurred_at FROM attendance_logs ORDER BY id')).rows).toEqual(sources);
  });

  it('cancels an approved request, returns exactly the consumed days and removes its attendance justification', async () => {
    const cancelled = await resolve(absence, 'cancel', 'Se pospone el viaje');
    expect(cancelled.status).toBe('cancelled');
    expect((await profile()).vacationBalance).toBe(10);
    expect((await card('2026-10-16')).days[0].status).toBe('no_records');
    await call('POST', `/leave-requests/${absence.id}/resolve`, { action: 'cancel', expectedVersion: cancelled.version, comments: 'Otra vez' }, 409);
    expect((await profile()).movements.map((movement: any) => movement.days).sort((a: number, b: number) => a-b)).toEqual([-2,2,10]);
  });

  it('justifies only the authorized arrival interval and restores deductions when cancelled', async () => {
    const first = await create(input('2026-10-12', undefined, { kind: 'late_arrival', authorizedTime: '10:00' }));
    await resolve(first);
    const day = (await card('2026-10-12')).days[0];
    expect(day.arrivalDelayMinutes).toBe(110);
    expect(day.incidents).toHaveLength(1); expect(day.incidents[0].minutes).toBe(20);
    const permitted = await create(input('2026-10-13', undefined, { kind: 'late_arrival', authorizedTime: '10:30', paid: false }));
    const approved = await resolve(permitted);
    expect((await card('2026-10-13')).days[0].incidents).toHaveLength(0);
    const deductions = await call('GET', '/attendance/deductions?from=2026-10-13&to=2026-10-13');
    expect(deductions.some((item: any) => item.subjectId === employeeId && !item.voidedAt)).toBe(false);
    await resolve(approved, 'cancel', 'Permiso registrado por error');
    expect((await card('2026-10-13')).days[0].incidents[0].minutes).toBe(110);
  });

  it('recognizes an authorized early departure and keeps real worked time and original schedule', async () => {
    const request = await create(input('2026-10-14', undefined, { kind: 'early_exit', authorizedTime: '12:30' }));
    await resolve(request);
    const attendance = await card('2026-10-14');
    expect(attendance.days[0]).toMatchObject({ earlyExitMinutes: 330, unauthorizedEarlyExitMinutes: 30, workedMinutes: 210 });
    expect(attendance.days[0].scheduleSettings.exitTime).toBe('17:30');
    expect(attendance.summary.earlyExits).toBe(1);
  });

  it('revalidates vacation availability at approval and rejects stale previews and unauthorized decisions', async () => {
    const staleInput = input('2026-10-21');
    const stale = await call('POST', '/leave-requests/preview', staleInput);
    await configure(employeeId, 1, bossId, '+525555555552');
    await call('POST', '/leave-requests', { input: staleInput, previewToken: stale.token, sourceKey: randomUUID() }, 409);
    const first = await create(input('2026-10-22', undefined, { useVacation: true }));
    const second = await create(input('2026-10-23', undefined, { useVacation: true }));
    await call('POST', `/leave-requests/${first.id}/resolve`, { action: 'approve', expectedVersion: first.version, actorEmployeeId: employeeId }, 400);
    await resolve(first);
    await call('POST', `/leave-requests/${second.id}/resolve`, { action: 'approve', expectedVersion: second.version }, 409);
    await resolve(second, 'reject', 'Sin saldo disponible');
    expect((await profile()).vacationBalance).toBe(0);
  });

  it('keeps daily and route overtime anchored to the original schedule with disjoint arrival and departure permissions', async () => {
    const scheduling = { effectiveFrom: '2026-01-01', workHours: null, meal: null, mealMode: 'inherit', recognitionMarginMinutes: 30,
      overtime: { enabled: true, workMode: 'daily', restEnabled: false, dailyRest: null, additionalRestMinutes: 0 } };
    await call('PUT', `/employees/${employeeId}/scheduling`, scheduling, 204);
    const before = (await card('2026-10-15')).days[0];
    const arrival = await create(input('2026-10-15', undefined, { kind: 'late_arrival', authorizedTime: '10:00' }));
    const departure = await create(input('2026-10-15', undefined, { kind: 'early_exit', authorizedTime: '16:00' }));
    await resolve(arrival); await resolve(departure);
    const daily = (await card('2026-10-15')).days[0];
    expect(daily.overtime).toEqual(before.overtime); expect(daily.workedMinutes).toBe(before.workedMinutes);
    expect(daily.leaveAuthorizations).toHaveLength(2); expect(daily.unauthorizedEarlyExitMinutes).toBe(0);
    await call('PUT', `/employees/${employeeId}/scheduling`, { ...scheduling, overtime: { ...scheduling.overtime, workMode: 'route' } }, 204);
    const route = (await card('2026-10-15')).days[0];
    expect(route.workedMinutes).toBe(before.workedMinutes); expect(route.overtime.netSeconds).toBe(before.overtime.netSeconds);
    expect(route.status).toBe('complete'); expect(route.leaveAuthorizations).toHaveLength(2);
    await call('PUT', `/employees/${employeeId}/scheduling`, scheduling, 204);
  });

  it('rolls back the decision, vacation movement and event if attendance recalculation fails', async () => {
    await configure(employeeId, 3, bossId, '+525555555552');
    const request = await create(input('2026-10-26', undefined, { useVacation: true }));
    const before = await profile();
    const service = new ManageLeave(new PrismaLeaveRepository(database, async () => { throw new Error('Simulated recalculation failure'); }),
      (value) => createHash('sha256').update(value).digest('hex'));
    await expect(service.resolve(request.id, { action: 'approve', expectedVersion: request.version, comments: '' },bossPrincipal)).rejects.toThrow('Simulated recalculation failure');
    expect((await call('GET', `/leave-requests/${request.id}`)).request.status).toBe('pending');
    expect(await profile()).toEqual(before);
    expect((await call('GET', `/leave-requests/${request.id}`)).events).toHaveLength(1);
  });

  it('rejects approval when a historical workday calendar changes and preserves the submitted dates', async () => {
    const request = await create(input('2026-11-06', '2026-11-09'));
    expect(request.details.days.map((day) => day.date)).toEqual(['2026-11-06','2026-11-09']);
    const configuration = await call('GET', `/branches/${branchId}/configuration`);
    await call('POST', `/branches/${branchId}/configuration`, { effectiveFrom: '2026-11-07', expectedVersionId: configuration.latestVersionId,
      workHours: { workDays: [1,2,3,4,5,6], entryTime: '08:30', exitTime: '17:30' },
      meal: { mode: 'disabled', startTime: '13:00', endTime: '13:00', durationMinutes: 60 }, recognitionMarginMinutes: 30,
      policy: configuration.policy.settings }, 201);
    await call('POST', `/leave-requests/${request.id}/resolve`, { action: 'approve', expectedVersion: request.version }, 409);
    expect((await call('GET', `/leave-requests/${request.id}`)).request.details.days).toEqual(request.details.days);
    const filtered = await call('GET', `/leave-requests?from=2026-11-01&to=2026-11-30&managerId=${bossId}&status=pending&limit=1`);
    expect(filtered.total).toBe(1); expect(filtered.requests[0].id).toBe(request.id);
  });
});
