import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { PrismaOrganizationDatasource } from '../src/infrastructure/datasources/organization-datasource.js';
import { PrismaDeviceDatasource } from '../src/infrastructure/datasources/device-datasource.js';
import { PrismaDeviceUserDatasource } from '../src/infrastructure/datasources/device-user-datasource.js';
import { PrismaAttendanceDatasource } from '../src/infrastructure/datasources/attendance-datasource.js';
import { branchSchema } from '../src/presentation/validators/organization.js';
import { dateAtLocalTime } from '../src/domain/entities/schedule-evaluator.js';
import type { Branch } from '../src/domain/entities/organization.js';
import { buildApp } from './helpers/build-test-app.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;

integration('versioned repeated-entry rules in PostgreSQL', () => {
  const schema = `test_entry_repeats_${randomUUID().replaceAll('-', '')}`;
  let admin: Database;
  let database: Database;

  beforeAll(async () => {
    admin = new Database(connection!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(scoped.toString());
    await runMigrations(database);
  }, 30000);

  afterAll(async () => {
    await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  it('round-trips branch settings, preserves prior effective dates and recalculates without changing original scans', async () => {
    const organization = new PrismaOrganizationDatasource(database);
    const devices = new PrismaDeviceDatasource(database);
    const users = new PrismaDeviceUserDatasource(database);
    const attendance = new PrismaAttendanceDatasource(database);
    const branches: Branch[] = [];
    for (const index of [0,1]) {
      const branch = (await organization.saveBranch(branchSchema.parse({ name: `Sucursal ${index}` })))!;
      branches.push(branch);
      await organization.addSchedule({ branchId: branch.id, name: 'Jornada', effectiveFrom: '2025-01-01', isDefault: true,
        settings: { workDays: [1,2,3,4,5,6,7], entryTime: '08:30', exitTime: '17:30', mealEnabled: false,
          mealStart: '00:00', mealEnd: '00:00', mealDurationMinutes: 60 } });
      const device = await devices.create({ name: `Reloj ${index}`, ipAddress: `127.0.0.${index + 1}`, branchId: branch.id });
      await users.upsert(device.id, { userId: '3062', name: 'Empleado de prueba', raw: { original: true } });
      for (const date of index === 0 ? ['2025-10-19','2025-10-20'] : ['2025-10-20']) {
        for (const [position, time] of ['07:59','08:06','15:21','16:30','18:53'].entries()) {
          await attendance.insertIfNew(device.id, { userId: '3062', deviceLogId: `${date}-${position}`, punchState: position % 2,
            occurredAt: dateAtLocalTime(date, time, branch.timeZone), raw: { originalPosition: position } });
        }
      }
    }
    const originals = (await database.query('SELECT * FROM attendance_logs ORDER BY id')).rows;
    const { app } = await buildApp({ database });
    const settings = { entryToleranceMinutes: 0, mealToleranceMinutes: 0, entryAllowedTardies: 3,
      mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 };
    try {
      const created = await app.inject({ method: 'POST', url: `/branches/${branches[0].id}/policies`,
        payload: { effectiveFrom: '2025-01-01', settings } });
      expect(created.statusCode).toBe(201);
      expect(created.json().settings.entryRepeatWindowMinutes).toBe(20);
      expect((await app.inject({ method: 'POST', url: `/branches/${branches[1].id}/policies`,
        payload: { effectiveFrom: '2025-01-01', settings: { ...settings, entryRepeatWindowMinutes: 5 } } })).statusCode).toBe(201);

      const reportUrl = `/attendance/daily?from=2025-10-19&to=2025-10-20&branchId=${branches[0].id}`;
      const before = (await app.inject({ method: 'GET', url: reportUrl })).json();
      expect(before).toHaveLength(2);
      expect(before.every((day: { result: { status: string } }) => day.result.status === 'complete')).toBe(true);
      expect((await app.inject({ method: 'POST', url: `/branches/${branches[0].id}/policies`,
        payload: { effectiveFrom: '2025-10-20', settings: { ...settings, entryRepeatWindowMinutes: 5 } } })).statusCode).toBe(201);
      const policies = (await app.inject({ method: 'GET', url: '/branch-policies' })).json();
      expect(policies.find((item: { branchId: string; effectiveFrom: string }) => item.branchId === branches[0].id && item.effectiveFrom === '2025-10-20').settings.entryRepeatWindowMinutes).toBe(5);
      const after = (await app.inject({ method: 'GET', url: reportUrl })).json();
      expect(after.find((day: { date: string }) => day.date === '2025-10-19').result.status).toBe('complete');
      expect(after.find((day: { date: string }) => day.date === '2025-10-20').result.status).toBe('ambiguous');
      expect(after.map((day: { id: string }) => day.id)).toEqual(before.map((day: { id: string }) => day.id));
      const other = (await app.inject({ method: 'GET', url: `/attendance/daily?from=2025-10-20&to=2025-10-20&branchId=${branches[1].id}` })).json();
      expect(other[0].result.status).toBe('ambiguous');
      expect((await database.query('SELECT * FROM attendance_logs ORDER BY id')).rows).toEqual(originals);
      expect((await app.inject({ method: 'POST', url: `/branches/${branches[0].id}/policies`,
        payload: { effectiveFrom: '2025-10-20', settings: { ...settings, entryRepeatWindowMinutes: -1 } } })).statusCode).toBe(400);
      expect((await database.query('SELECT COUNT(*)::int AS count FROM branch_policies')).rows[0].count).toBe(3);
    } finally { await app.close(); }
  }, 30000);
});
