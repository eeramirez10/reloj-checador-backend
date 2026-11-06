import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './helpers/build-test-app.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;

integration('atomic employee editing across tabs', () => {
  const schema = `test_employee_editor_${randomUUID().replaceAll('-', '')}`;
  let admin: Database; let database: Database; let services: Awaited<ReturnType<typeof buildApp>>;
  let employeeId: string; let bossId: string;
  const scheduling = { effectiveFrom: '2026-10-01', workHours: { workDays: [1,2,3,4,5], entryTime: '09:00', exitTime: '18:00' },
    meal: { enabled: true, startTime: '14:00', endTime: '14:00', durationMinutes: 60 }, mealMode: 'individual',
    recognitionMarginMinutes: 30, recognitionMarginInherited: false,
    overtime: { enabled: true, workMode: 'daily', restEnabled: false, dailyRest: null, additionalRestMinutes: 0 } };

  async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object, expected = 200) {
    const response = await services.app.inject({ method, url, payload });
    expect(response.statusCode, response.body).toBe(expected);
    return response.body ? response.json() : undefined;
  }
  const profile = () => call('GET', `/employees/${employeeId}/leave-profile`);
  const schedule = () => call('GET', `/employees/${employeeId}/scheduling`);
  async function snapshot() {
    return { employee: await call('GET', `/employees/${employeeId}`), scheduling: await schedule(), profile: await profile(),
      history: await call('GET', `/employees/${employeeId}/history`) };
  }
  async function payload() {
    const current = await profile(); const currentSchedule = await schedule();
    return { firstName: 'Cambio en otra pestaña', isActive: false,
      scheduling: { ...scheduling, meal: { ...scheduling.meal, durationMinutes: 45 }, expectedVersionId: currentSchedule.latestVersionId },
      leaveProfile: { managerId: bossId, whatsappPhone: '+525555555552', vacationBalance: 15, adjustmentReason: 'Ajuste documentado', expectedVersion: current.version } };
  }

  beforeAll(async () => {
    admin = new Database(connection!); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection!); url.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(url.toString()); await runMigrations(database); services = await buildApp({ database });
    const branchId = (await call('POST', '/branches', { name: 'Edición por pestañas' }, 201)).id;
    await call('POST', `/branches/${branchId}/configuration`, { effectiveFrom: '2026-01-01',
      workHours: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30' },
      meal: { mode: 'disabled', startTime: '13:00', endTime: '13:00', durationMinutes: 60 }, recognitionMarginMinutes: 30,
      policy: { entryToleranceMinutes: 5, mealToleranceMinutes: 5, entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'calendar_month', accumulationDays: 30 } }, 201);
    bossId = (await call('POST', '/employees', { firstName: 'Jefa', branchId }, 201)).id;
    employeeId = (await call('POST', '/employees', { firstName: 'Empleado', lastName: 'Original', branchId }, 201)).id;
    await call('PUT', `/employees/${bossId}/leave-profile`, { managerId: null, whatsappPhone: '+525555555551', vacationBalance: 0, expectedVersion: 0, adjustmentReason: '' });
  }, 30000);
  afterAll(async () => { await services?.app.close(); await database?.close(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); } });

  it('saves personal data, scheduling, meal, overtime and vacation balance in one edit', async () => {
    await call('PATCH', `/employees/${employeeId}`, { firstName: 'Empleado editado', scheduling: { ...scheduling, expectedVersionId: null },
      leaveProfile: { managerId: bossId, whatsappPhone: '+525555555552', vacationBalance: 12, expectedVersion: 0, adjustmentReason: 'Saldo inicial validado' } }, 204);
    const state = await snapshot();
    expect(state.employee.firstName).toBe('Empleado editado');
    expect(state.scheduling.version).toMatchObject({ workHours: scheduling.workHours, meal: scheduling.meal, overtime: scheduling.overtime });
    expect(state.profile).toMatchObject({ managerId: bossId, whatsappPhone: '+525555555552', vacationBalance: 12 });
    expect(state.profile.movements).toHaveLength(1); expect(state.profile.movements[0].days).toBe(12);
  });

  it('rolls back other tabs and employment status when the manager or adjustment is invalid', async () => {
    const before = await snapshot(); const edit = await payload();
    await call('PATCH', `/employees/${employeeId}`, { ...edit, leaveProfile: { ...edit.leaveProfile, managerId: employeeId } }, 400);
    expect(await snapshot()).toEqual(before);
    await call('PATCH', `/employees/${employeeId}`, { ...edit, leaveProfile: { ...edit.leaveProfile, adjustmentReason: '' } }, 400);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects stale balances and duplicate phone numbers without saving a name, schedule version or ledger entry', async () => {
    const before = await snapshot(); const edit = await payload();
    await call('PATCH', `/employees/${employeeId}`, { ...edit, leaveProfile: { ...edit.leaveProfile, expectedVersion: 0 } }, 409);
    expect(await snapshot()).toEqual(before);
    await call('PATCH', `/employees/${employeeId}`, { ...edit, leaveProfile: { ...edit.leaveProfile, whatsappPhone: '+525555555551' } }, 409);
    expect(await snapshot()).toEqual(before);
    await call('PATCH', `/employees/${employeeId}`, { ...edit, scheduling: { ...edit.scheduling, expectedVersionId: null } }, 409);
    expect(await snapshot()).toEqual(before);
  });

  it('serializes concurrent full edits so exactly one version and vacation adjustment is committed', async () => {
    const current = await profile(); const currentSchedule = await schedule();
    const edit = { scheduling: { ...scheduling, expectedVersionId: currentSchedule.latestVersionId }, leaveProfile: {
      managerId: bossId, whatsappPhone: '+525555555552', vacationBalance: 15, expectedVersion: current.version, adjustmentReason: 'Nueva carga de días' } };
    const responses = await Promise.all(['Primero', 'Segundo'].map((firstName) => services.app.inject({ method: 'PATCH', url: `/employees/${employeeId}`, payload: { ...edit, firstName } })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([204,409]);
    const state = await snapshot();
    expect(state.profile.vacationBalance).toBe(15); expect(state.profile.movements).toHaveLength(2);
    expect(state.scheduling.history).toHaveLength(2); expect(state.employee.isActive).toBe(true);
    const winner = responses[0].statusCode === 204 ? 'Primero' : 'Segundo';
    expect(state.employee.firstName).toBe(winner);
  });
});
