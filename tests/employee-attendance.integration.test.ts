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
import type { EmployeeAttendanceCard } from '../src/domain/entities/employee-attendance.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;

integration('individual attendance cards in PostgreSQL', () => {
  const schema = `test_attendance_card_${randomUUID().replaceAll('-', '')}`;
  let admin: Database;
  let database: Database;
  let employeeId: string;

  beforeAll(async () => {
    admin = new Database(connection!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(scoped.toString());
    await runMigrations(database);
    const organization = new PrismaOrganizationDatasource(database);
    const mexico = (await organization.saveBranch(branchSchema.parse({ name: 'México' })))!;
    const cancun = (await organization.saveBranch(branchSchema.parse({ name: 'Cancún', timeZone: 'America/Cancun' })))!;
    const settings = { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30', mealEnabled: false,
      mealStart: '00:00', mealEnd: '00:00', mealDurationMinutes: 60 };
    for (const branch of [mexico,cancun]) {
      await organization.addSchedule({ branchId: branch.id, name: `Base ${branch.name}`, effectiveFrom: '2025-10-01', isDefault: true,
        settings: branch.id === mexico.id ? settings : { ...settings, entryTime: '08:00', exitTime: '16:00' } });
      await organization.addPolicy(branch.id, { effectiveFrom: '2025-10-01', settings: { entryToleranceMinutes: 15,
        mealToleranceMinutes: 0, entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 } });
    }
    await organization.addSchedule({ branchId: mexico.id, name: 'Nueva jornada México', effectiveFrom: '2025-10-14', isDefault: true,
      settings: { ...settings, entryTime: '09:00', exitTime: '18:00' } });
    const device = await new PrismaDeviceDatasource(database).create({ name: 'Reloj México', ipAddress: '127.0.0.1', branchId: mexico.id });
    const other = await new PrismaDeviceDatasource(database).create({ name: 'Reloj Cancún', ipAddress: '127.0.0.2', branchId: cancun.id });
    const users = new PrismaDeviceUserDatasource(database);
    await users.upsert(device.id, { userId: '3062', name: 'Empleado de México', raw: {} });
    await users.upsert(other.id, { userId: '3062', name: 'Otra persona con el mismo ID', raw: {} });
    employeeId = (await users.list({ deviceId: device.id, limit: 500 }))[0].employeeId!;
    await organization.assignBranch(mexico.id, { employeeIds: [employeeId], deviceUserIds: [], effectiveFrom: '2025-10-01' });
    await organization.assignBranch(cancun.id, { employeeIds: [employeeId], deviceUserIds: [], effectiveFrom: '2025-10-16' });
    const scheduling = new PrismaEmployeeSchedulingDatasource(database);
    await scheduling.append(employeeId, { effectiveFrom: '2025-10-15', workHours: { workDays: [1,2,3,4,5], entryTime: '10:00', exitTime: '19:00' }, meal: null, recognitionMarginMinutes: 30 });
    await scheduling.append(employeeId, { effectiveFrom: '2025-10-17', workHours: null, meal: null, recognitionMarginMinutes: 30 });
    const attendance = new PrismaAttendanceDatasource(database);
    for (const [date,times] of [
      ['2025-10-13',['08:40','08:46','13:30','14:30','17:35']],
      ['2025-10-14',['09:16','13:30','14:30','17:30']],
      ['2025-10-15',['10:00','14:31','15:35']],
    ] as const) {
      for (const [index,time] of times.entries()) await attendance.insertIfNew(device.id, { userId: '3062', deviceLogId: `${date}-${index}`,
        occurredAt: dateAtLocalTime(date, time, 'America/Mexico_City'), punchState: index % 2, raw: { originalIndex: index } });
    }
    await attendance.insertIfNew(other.id, { userId: '3062', deviceLogId: 'other-person', occurredAt: dateAtLocalTime('2025-10-13','12:00','America/Cancun'), raw: {} });
    await createAttendanceEvaluation(database, organization).recalculate();
  }, 30000);

  afterAll(async () => {
    await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  it('combines canonical movements with a complete calendar, historical work hours and branch transfers without writing data', async () => {
    const before = (await database.query('SELECT * FROM attendance_logs ORDER BY id')).rows;
    const evaluations = (await database.query('SELECT * FROM attendance_evaluations ORDER BY id')).rows;
    const { app } = await buildApp({ database });
    try {
      const response = await app.inject({ method: 'GET', url: `/employees/${employeeId}/attendance?from=2025-10-11&to=2025-10-19` });
      expect(response.statusCode).toBe(200);
      const card = response.json<EmployeeAttendanceCard>();
      expect(card.employee.id).toBe(employeeId);
      expect(card.days).toHaveLength(9);
      const day = (date: string) => card.days.find((item) => item.date === date)!;
      expect(day('2025-10-11').status).toBe('day_off');
      expect(day('2025-10-12').status).toBe('day_off');
      expect(day('2025-10-13').scheduleSettings?.entryTime).toBe('08:30');
      expect(day('2025-10-13').punches.map((punch) => punch.movement)).toEqual(['entry','duplicate','meal_departure','meal_return','exit']);
      expect(day('2025-10-13').arrivalDelayMinutes).toBe(10);
      expect(day('2025-10-13').incidents).toHaveLength(0);
      expect(day('2025-10-14').scheduleSettings?.entryTime).toBe('09:00');
      expect(day('2025-10-14').earlyExitMinutes).toBe(30);
      expect(day('2025-10-14').arrivalDelayMinutes).toBe(16);
      expect(day('2025-10-15').scheduleSettings?.entryTime).toBe('10:00');
      expect(day('2025-10-15').workedMinutes).toBeNull();
      expect(day('2025-10-15').missingMovements).toEqual(['meal_return']);
      expect(day('2025-10-16')).toMatchObject({ branchName: 'Cancún', timeZone: 'America/Cancun', status: 'no_records' });
      expect(day('2025-10-16').scheduleSettings?.entryTime).toBe('10:00');
      expect(day('2025-10-17').scheduleSettings?.entryTime).toBe('08:00');
      expect(day('2025-10-18').status).toBe('day_off');
      expect(card.summary).toMatchObject({ recordedDays: 3, completeDays: 2, incompleteDays: 1, daysWithoutRecords: 2,
        daysOff: 4, arrivalTardies: 1, mealTardies: 0, earlyExits: 2, calculableDays: 2 });
      expect(card.summary.workedMinutes).toBe(day('2025-10-13').workedMinutes! + day('2025-10-14').workedMinutes!);
      const canonical = (await app.inject({ method: 'GET', url: `/attendance/daily?from=2025-10-13&to=2025-10-15&subjectId=${employeeId}` })).json();
      for (const row of canonical) {
        expect(day(row.date).punches).toEqual(row.result.punches);
        expect(day(row.date).exit).toBe(row.result.exit);
      }
      expect((await database.query('SELECT * FROM attendance_logs ORDER BY id')).rows).toEqual(before);
      expect((await database.query('SELECT * FROM attendance_evaluations ORDER BY id')).rows).toEqual(evaluations);
    } finally { await app.close(); }
  }, 30000);

  it('rejects invalid ranges and employee IDs, supports a single date and returns 404 for unknown employees', async () => {
    const { app } = await buildApp({ database });
    try {
      for (const query of ['', '?from=2025-10-13', '?from=2025-10-14&to=2025-10-13', '?from=2025-02-30&to=2025-03-01', '?from=2025-01-01&to=2026-01-02']) {
        expect((await app.inject({ method: 'GET', url: `/employees/${employeeId}/attendance${query}` })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: 'GET', url: '/employees/not-a-uuid/attendance?from=2025-10-13&to=2025-10-13' })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: `/employees/${randomUUID()}/attendance?from=2025-10-13&to=2025-10-13` })).statusCode).toBe(404);
      const response = await app.inject({ method: 'GET', url: `/employees/${employeeId}/attendance?from=2025-10-13&to=2025-10-13` });
      expect(response.statusCode).toBe(200);
      expect(response.json().days).toHaveLength(1);
    } finally { await app.close(); }
  }, 30000);
});
