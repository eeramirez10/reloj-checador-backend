import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { PrismaOrganizationDatasource } from '../src/infrastructure/datasources/organization-datasource.js';
import { PrismaDeviceDatasource } from '../src/infrastructure/datasources/device-datasource.js';
import { PrismaDeviceUserDatasource } from '../src/infrastructure/datasources/device-user-datasource.js';
import { PrismaAttendanceDatasource } from '../src/infrastructure/datasources/attendance-datasource.js';
import { PrismaEmployeeSchedulingDatasource } from '../src/infrastructure/datasources/employee-scheduling-datasource.js';
import { buildApp, createAttendanceEvaluation } from './helpers/build-test-app.js';
import { branchSchema } from '../src/presentation/validators/organization.js';
import { dateAtLocalTime } from '../src/domain/entities/schedule-evaluator.js';
import type { BranchConfigurationInput, configurationView } from '../src/domain/entities/branch-configuration.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;
type ConfigurationView = ReturnType<typeof configurationView>;
const policy = { entryToleranceMinutes: 15, mealToleranceMinutes: 15, entryAllowedTardies: 3, mealAllowedTardies: 3,
  accumulationMode: 'first_lateness' as const, accumulationDays: 30, entryRepeatWindowMinutes: 20 };
const input: BranchConfigurationInput = { effectiveFrom: '2025-10-14', workHours: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30' },
  meal: { mode: 'configured', startTime: '13:30', endTime: '13:30', durationMinutes: 60 }, recognitionMarginMinutes: 30, policy };

integration('unified branch configuration and lossless deletion', () => {
  const schema = `test_branch_config_${randomUUID().replaceAll('-', '')}`;
  let admin: Database;
  let database: Database;
  let branchId: string;
  let commonId: string;
  let personalId: string;

  async function originals() {
    const records: Record<string, unknown> = {};
    for (const table of ['attendance_logs','device_user_photos','employees','device_users','branch_assignments','schedule_assignments','employee_schedule_versions']) {
      records[table] = (await database.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return records;
  }

  beforeAll(async () => {
    admin = new Database(connection!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(scoped.toString());
    await runMigrations(database);
    const organization = new PrismaOrganizationDatasource(database);
    branchId = (await organization.saveBranch(branchSchema.parse({ name: 'Sucursal de prueba' })))!.id;
    await organization.addSchedule({ branchId, name: 'Base anterior', effectiveFrom: '2025-01-01', isDefault: true,
      settings: { ...input.workHours, mealEnabled: false, mealStart: '00:00', mealEnd: '00:00', mealDurationMinutes: 60 } });
    await organization.addPolicy(branchId, { effectiveFrom: '2025-01-01', settings: policy });
    const device = await new PrismaDeviceDatasource(database).create({ name: 'Reloj', ipAddress: '127.0.0.1', branchId });
    const users = new PrismaDeviceUserDatasource(database);
    for (const userId of ['3062','1517']) await users.upsert(device.id, { userId, name: `Persona ${userId}`, raw: { original: userId } });
    const people = await users.list({ deviceId: device.id, limit: 500 });
    commonId = people.find((item) => item.userId === '3062')!.employeeId!;
    personalId = people.find((item) => item.userId === '1517')!.employeeId!;
    await new PrismaEmployeeSchedulingDatasource(database).append(personalId, { effectiveFrom: '2025-01-01', workHours: null,
      meal: { enabled: true, startTime: '14:00', endTime: '15:00', durationMinutes: 60 }, recognitionMarginMinutes: 30 });
    await database.query(`INSERT INTO device_user_photos (device_id,device_user_id,content_type,image_data)
      VALUES ($1,'3062','image/jpeg',$2)`, [device.id, Buffer.from([0xff,0xd8,0xff,0xd9])]);
    const logs = new PrismaAttendanceDatasource(database);
    for (const date of ['2025-10-13','2025-10-14','2025-10-15']) {
      for (const [index,time] of ['08:40','08:46','13:50','15:10','17:35'].entries()) await logs.insertIfNew(device.id,
        { userId: '3062', deviceLogId: `${date}-${index}`, occurredAt: dateAtLocalTime(date,time,'America/Mexico_City'), punchState: index % 2, raw: { originalIndex: index } });
    }
    for (const [index,time] of ['08:30','14:10','15:10','17:40'].entries()) await logs.insertIfNew(device.id,
      { userId: '1517', deviceLogId: `personal-${index}`, occurredAt: dateAtLocalTime('2025-10-14',time,'America/Mexico_City'), raw: {} });
    await createAttendanceEvaluation(database, organization).recalculate();
  }, 30000);

  afterAll(async () => {
    await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  it('saves work hours and rules together, respects personal meals and deletes with recalculation while preserving every source record', async () => {
    const source = await originals();
    const evaluationIds = (await database.query('SELECT id FROM attendance_evaluations ORDER BY id')).rows;
    const { app } = await buildApp({ database });
    try {
      const url = `/branches/${branchId}/configuration`;
      const previous = (await app.inject({ method: 'GET', url })).json<ConfigurationView>();
      const saved = await app.inject({ method: 'POST', url, payload: { ...input, expectedVersionId: previous.latestVersionId } });
      expect(saved.statusCode).toBe(201);
      const current = saved.json<ConfigurationView>();
      expect(current.schedule?.configurationId).toBe(current.policy?.configurationId);
      expect(current.schedule?.settings.branchMeal?.mode).toBe('configured');
      const report = (await app.inject({ method: 'GET', url: `/attendance/daily?from=2025-10-13&to=2025-10-15&subjectId=${commonId}` })).json();
      expect(report.find((row: any) => row.date === '2025-10-13').result.mealDetection).toBe('automatic');
      expect(report.find((row: any) => row.date === '2025-10-14').result.incidents).toHaveLength(2);
      expect(report.find((row: any) => row.date === '2025-10-14').result.punches[1].movement).toBe('duplicate');
      const person = (await app.inject({ method: 'GET', url: `/employees/${personalId}/scheduling?date=2025-10-14` })).json();
      expect(person.resolved.settings).toMatchObject({ mealStart: '14:00', mealEnd: '15:00', mealSource: 'individual' });
      const deductions = (await database.query('SELECT id FROM attendance_deductions WHERE voided_at IS NULL')).rows;
      expect(deductions).toHaveLength(1);
      const incidents = (await database.query('SELECT id FROM attendance_incidents ORDER BY id')).rows;
      const removed = await app.inject({ method: 'DELETE', url: `${url}/versions/${current.schedule!.configurationId}`,
        payload: { expectedVersionId: current.latestVersionId } });
      expect(removed.statusCode).toBe(200);
      const restored = removed.json<ConfigurationView>();
      expect(restored.schedule?.id).toBe(previous.schedule?.id);
      expect(restored.policy?.id).toBe(previous.policy?.id);
      expect(restored.history.find((item) => item.id === current.schedule!.configurationId)?.deletedAt).toBeTruthy();
      expect((await database.query('SELECT id FROM attendance_evaluations ORDER BY id')).rows).toEqual(evaluationIds);
      expect((await database.query('SELECT id FROM attendance_incidents ORDER BY id')).rows).toEqual(incidents);
      expect((await database.query('SELECT id FROM attendance_deductions WHERE voided_at IS NOT NULL')).rows).toEqual(deductions);
      expect((await database.query('SELECT COUNT(*)::int AS count FROM attendance_deductions WHERE voided_at IS NULL')).rows[0].count).toBe(0);
      expect(await originals()).toEqual(source);
      expect((await app.inject({ method: 'POST', url, payload: { ...input, expectedVersionId: previous.latestVersionId } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'DELETE', url: `${url}/versions/${randomUUID()}` })).statusCode).toBe(404);
    } finally { await app.close(); }
  }, 30000);

  it('persists inherited and explicit automatic employee modes independently of branch defaults', async () => {
    const { app } = await buildApp({ database });
    try {
      const configuration = (await app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: { ...input, recognitionMarginMinutes: 45 } })).json<ConfigurationView>();
      const url = `/employees/${commonId}/scheduling`;
      const personal = { effectiveFrom: '2025-10-14', workHours: { workDays: [1,2,3,4,5], entryTime: '09:00', exitTime: '18:00' },
        meal: null, mealMode: 'inherit', recognitionMarginMinutes: 30, recognitionMarginInherited: true };
      expect((await app.inject({ method: 'PUT', url, payload: personal })).statusCode).toBe(204);
      const inherited = (await app.inject({ method: 'GET', url: `${url}?date=2025-10-14` })).json();
      expect(inherited.version).toMatchObject({ mealMode: 'inherit', recognitionMarginInherited: true });
      expect(inherited.resolved.settings).toMatchObject({ entryTime: '09:00', exitTime: '18:00', mealStart: '13:30', recognitionMarginMinutes: 45 });
      expect((await app.inject({ method: 'PUT', url, payload: { ...personal, mealMode: 'automatic' } })).statusCode).toBe(204);
      const automatic = (await app.inject({ method: 'GET', url: `${url}?date=2025-10-14` })).json();
      expect(automatic.resolved.settings.mealDetection).toBe('automatic');
      expect((await app.inject({ method: 'PUT', url, payload: { ...personal, workHours: null } })).statusCode).toBe(204);
      expect((await app.inject({ method: 'DELETE', url: `/branches/${branchId}/configuration/versions/${configuration.schedule!.id}` })).statusCode).toBe(200);
      const restored = (await app.inject({ method: 'GET', url: `${url}?date=2025-10-14` })).json();
      expect(restored.resolved.settings).toMatchObject({ entryTime: '08:30', mealDetection: 'automatic', recognitionMarginMinutes: 30 });
    } finally { await app.close(); }
  }, 30000);

  it('rolls back the workday when the policy insert fails', async () => {
    const { app } = await buildApp({ database });
    const before = (await database.query('SELECT id FROM work_schedules ORDER BY id')).rows;
    await database.executeScript(`CREATE FUNCTION reject_branch_policy() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced_policy_failure'; END $$;
      CREATE TRIGGER reject_branch_policy BEFORE INSERT ON branch_policies FOR EACH ROW EXECUTE FUNCTION reject_branch_policy();`);
    try {
      expect((await app.inject({ method: 'POST', url: `/branches/${branchId}/configuration`, payload: input })).statusCode).toBe(500);
      expect((await database.query('SELECT id FROM work_schedules ORDER BY id')).rows).toEqual(before);
    } finally {
      await database.executeScript('DROP TRIGGER reject_branch_policy ON branch_policies; DROP FUNCTION reject_branch_policy();');
      await app.close();
    }
  }, 30000);

  it('handles concurrent saves and restores overwritten timelines after deleting a backdated configuration', async () => {
    const branch = (await new PrismaOrganizationDatasource(database).saveBranch(branchSchema.parse({ name: 'Otra sucursal' })))!;
    const { app } = await buildApp({ database });
    const url = `/branches/${branch.id}/configuration`;
    try {
      const responses = await Promise.all([0,1].map(() => app.inject({ method: 'POST', url, payload: { ...input, expectedVersionId: null } })));
      expect(responses.map((response) => response.statusCode).sort()).toEqual([201,409]);
      const first = responses.find((response) => response.statusCode === 201)!.json<ConfigurationView>();
      const second = (await app.inject({ method: 'POST', url, payload: { ...input, effectiveFrom: '2025-10-20', expectedVersionId: first.latestVersionId } })).json<ConfigurationView>();
      const backdated = (await app.inject({ method: 'POST', url, payload: { ...input, effectiveFrom: '2025-10-01', expectedVersionId: second.latestVersionId } })).json<ConfigurationView>();
      expect(backdated.schedule?.effectiveFrom).toBe('2025-10-01');
      const restored = (await app.inject({ method: 'DELETE', url: `${url}/versions/${backdated.schedule!.id}`,
        payload: { expectedVersionId: backdated.latestVersionId } })).json<ConfigurationView>();
      expect(restored.schedule?.effectiveFrom).toBe('2025-10-20');
      expect(restored.policy?.effectiveFrom).toBe('2025-10-20');
      expect((await app.inject({ method: 'DELETE', url: `/branches/${branchId}/configuration/versions/${restored.schedule!.id}` })).statusCode).toBe(404);
      for (const version of restored.history.filter((item) => !item.deletedAt)) expect(version.schedule?.supersededFrom).toBeNull();
    } finally { await app.close(); }
  }, 30000);

  it('deletes a legacy base without deleting its assignments or original evaluations', async () => {
    const { app } = await buildApp({ database });
    try {
      const url = `/branches/${branchId}/configuration`;
      const previous = (await app.inject({ method: 'GET', url })).json<ConfigurationView>();
      const removed = await app.inject({ method: 'DELETE', url: `${url}/versions/${previous.schedule!.id}`, payload: { expectedVersionId: previous.latestVersionId } });
      expect(removed.statusCode).toBe(200);
      expect(removed.json().schedule).toBeNull();
      const report = (await app.inject({ method: 'GET', url: `/attendance/daily?from=2025-10-14&to=2025-10-14&subjectId=${commonId}` })).json();
      expect(report[0].result.status).toBe('unconfigured');
      expect(report[0].result.punches).toHaveLength(5);
      expect((await database.query('SELECT COUNT(*)::int AS count FROM attendance_logs')).rows[0].count).toBe(19);
    } finally { await app.close(); }
  }, 30000);
});
