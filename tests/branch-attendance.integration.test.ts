import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { PrismaOrganizationDatasource } from '../src/infrastructure/datasources/organization-datasource.js';
import { PrismaDeviceDatasource } from '../src/infrastructure/datasources/device-datasource.js';
import { PrismaDeviceUserDatasource } from '../src/infrastructure/datasources/device-user-datasource.js';
import { PrismaAttendanceDatasource } from '../src/infrastructure/datasources/attendance-datasource.js';
import { PrismaBranchAttendanceDatasource } from '../src/infrastructure/datasources/branch-attendance-datasource.js';
import { buildApp, createAttendanceEvaluation } from './helpers/build-test-app.js';
import { branchSchema } from '../src/presentation/validators/organization.js';
import { dateAtLocalTime } from '../src/domain/entities/schedule-evaluator.js';
import type { BranchAttendanceCards, BranchAttendanceExport, BranchAttendanceQuery } from '../src/domain/entities/branch-attendance.js';
import type { EmployeeAttendanceCard } from '../src/domain/entities/employee-attendance.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;
const period = { from: '2026-10-17', to: '2026-10-20' };

integration('branch attendance cards in PostgreSQL', () => {
  const schema = `test_branch_cards_${randomUUID().replaceAll('-', '')}`;
  let admin: Database;
  let database: Database;
  let mexicoId: string;
  let cancunId: string;
  let emptyBranchId: string;
  let anaId: string;
  let brunoId: string;
  let carlosId: string;
  let inactiveId: string;
  let otherId: string;
  let deviceId: string;

  async function protectedData() {
    const tables: Record<string, unknown> = {};
    for (const table of ['attendance_logs','attendance_evaluations','attendance_incidents','attendance_deductions','employees','device_users','device_user_photos','branch_assignments']) {
      tables[table] = (await database.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return tables;
  }

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
    mexicoId = mexico.id;
    cancunId = cancun.id;
    emptyBranchId = (await organization.saveBranch(branchSchema.parse({ name: 'Sin empleados' })))!.id;
    for (const branch of [mexico,cancun]) await organization.addSchedule({ branchId: branch.id, name: `Base ${branch.name}`, effectiveFrom: '2026-01-01', isDefault: true,
      settings: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30', mealEnabled: false, mealStart: '00:00', mealEnd: '00:00', mealDurationMinutes: 60 } });
    const devices = new PrismaDeviceDatasource(database);
    const device = await devices.create({ name: 'Reloj México', ipAddress: '127.0.0.1', branchId: mexicoId });
    deviceId = device.id;
    const other = await devices.create({ name: 'Reloj Cancún', ipAddress: '127.0.0.2', branchId: cancunId });
    const users = new PrismaDeviceUserDatasource(database);
    for (const [userId,name] of [['3062','Ana'],['3069','Bruno'],['3070','Carlos'],['3071','Diana'],['3072','Ficha anterior']]) {
      await users.upsert(device.id, { userId, name, raw: { originalName: name } });
    }
    await users.upsert(other.id, { userId: '3062', name: 'Otra persona', raw: {} });
    const people = await users.list({ deviceId: device.id, limit: 500 });
    anaId = people.find((person) => person.userId === '3062')!.employeeId!;
    brunoId = people.find((person) => person.userId === '3069')!.employeeId!;
    carlosId = people.find((person) => person.userId === '3070')!.employeeId!;
    inactiveId = people.find((person) => person.userId === '3071')!.employeeId!;
    const merged = people.find((person) => person.userId === '3072')!.employeeId!;
    otherId = (await users.list({ deviceId: other.id, limit: 500 }))[0].employeeId!;
    await database.query('UPDATE employees SET is_active=FALSE WHERE id=$1', [inactiveId]);
    await database.query("UPDATE employees SET identification_status='merged', merged_into_id=$2 WHERE id=$1", [merged,anaId]);
    await organization.assignBranch(mexicoId, { employeeIds: [otherId], deviceUserIds: [], effectiveFrom: '2026-01-01' });
    await organization.assignBranch(cancunId, { employeeIds: [otherId], deviceUserIds: [], effectiveFrom: '2026-10-20' });
    const attendance = new PrismaAttendanceDatasource(database);
    for (const [userId,times] of [
      ['3062',['07:59','08:06','15:21','16:30','18:53']],
      ['3069',['08:24','14:31','15:35']],
      ['3071',['08:30']],
    ] as const) for (const [index,time] of times.entries()) await attendance.insertIfNew(device.id,
      { userId, deviceLogId: `${userId}-${index}`, occurredAt: dateAtLocalTime('2026-10-19',time,mexico.timeZone), punchState: index % 2, raw: { originalIndex: index } });
    await attendance.insertIfNew(other.id, { userId: '3062', deviceLogId: 'other-person', occurredAt: dateAtLocalTime('2026-10-19','12:00',mexico.timeZone), raw: {} });
    await database.query(`INSERT INTO device_user_photos (device_id,device_user_id,content_type,image_data) VALUES ($1,'3062','image/jpeg',$2)`, [device.id,Buffer.from([0xff,0xd8,0xff,0xd9])]);
    await createAttendanceEvaluation(database, organization).recalculate();
  }, 30000);

  afterAll(async () => {
    await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  function reportUrl(branchId: string, employeeStatus = 'active', page = 1, limit = 2) {
    return `/attendance/cards?branchId=${branchId}&employeeStatus=${employeeStatus}&from=${period.from}&to=${period.to}&page=${page}&limit=${limit}`;
  }

  it('returns all matching staff across pages with cards identical to the individual report, including staff without punches', async () => {
    const before = await protectedData();
    const { app } = await buildApp({ database });
    try {
      const firstResponse = await app.inject({ method: 'GET', url: reportUrl(mexicoId) });
      expect(firstResponse.statusCode).toBe(200);
      const first = firstResponse.json<BranchAttendanceCards>();
      const second = (await app.inject({ method: 'GET', url: reportUrl(mexicoId,'active',2) })).json<BranchAttendanceCards>();
      expect(first).toMatchObject({ page: 1, pageSize: 2, totalEmployees: 3, totalPages: 2, employeeStatus: 'active' });
      expect(first.cards.map((card) => card.employee.id)).toEqual([anaId,brunoId]);
      expect(second.cards.map((card) => card.employee.id)).toEqual([carlosId]);
      for (const card of [...first.cards,...second.cards]) {
        const individual = (await app.inject({ method: 'GET', url: `/employees/${card.employee.id}/attendance?from=${period.from}&to=${period.to}` })).json<EmployeeAttendanceCard>();
        expect(card).toEqual(individual);
      }
      const completed = first.cards[0].days.find((day) => day.date === '2026-10-19')!;
      expect(completed.punches.map((punch) => punch.movement)).toEqual(['entry','duplicate','meal_departure','meal_return','exit']);
      expect(first.cards[1].days.find((day) => day.date === '2026-10-19')).toMatchObject({ status: 'incomplete', workedMinutes: null, missingMovements: ['meal_return'] });
      expect(second.cards[0].days.map((day) => day.status)).toEqual(['day_off','day_off','no_records','no_records']);
      const last = (await app.inject({ method: 'GET', url: reportUrl(mexicoId,'active',99) })).json<BranchAttendanceCards>();
      expect(last.page).toBe(2);
      expect(last.cards.map((card) => card.employee.id)).toEqual([carlosId]);
      expect(await protectedData()).toEqual(before);
    } finally { await app.close(); }
  }, 30000);

  it('filters by the current branch and active state without confusing repeated clock IDs', async () => {
    const { app } = await buildApp({ database });
    try {
      const inactive = (await app.inject({ method: 'GET', url: reportUrl(mexicoId,'inactive') })).json<BranchAttendanceCards>();
      expect(inactive.totalEmployees).toBe(1);
      expect(inactive.cards.map((card) => card.employee.id)).toEqual([inactiveId]);
      expect(inactive.cards[0].employee.isActive).toBe(false);
      const cancun = (await app.inject({ method: 'GET', url: reportUrl(cancunId) })).json<BranchAttendanceCards>();
      expect(cancun.totalEmployees).toBe(1);
      expect(cancun.cards[0].employee.id).toBe(otherId);
      expect(cancun.cards[0].days.find((day) => day.date === '2026-10-19')?.branchName).toBe('México');
      const empty = (await app.inject({ method: 'GET', url: reportUrl(emptyBranchId) })).json<BranchAttendanceCards>();
      expect(empty).toMatchObject({ totalEmployees: 0, totalPages: 0, page: 1, cards: [] });
    } finally { await app.close(); }
  }, 30000);

  it('requires all filters and validates dates, pagination and branch identity', async () => {
    const { app } = await buildApp({ database });
    try {
      const valid = { branchId: mexicoId, employeeStatus: 'active', ...period };
      for (const field of Object.keys(valid)) {
        const incomplete = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field));
        expect((await app.inject({ method: 'GET', url: `/attendance/cards?${new URLSearchParams(incomplete)}` })).statusCode).toBe(400);
      }
      const invalidQueries: Array<Record<string, string>> = [{ employeeStatus: 'all' }, { branchId: 'invalid' }, { from: '2026-02-30' }, { from: '2026-10-21' },
        { from: '2025-01-01', to: '2026-01-02' }, { page: '0' }, { page: '1.5' }, { limit: '11' }];
      for (const changes of invalidQueries) {
        expect((await app.inject({ method: 'GET', url: `/attendance/cards?${new URLSearchParams({ ...valid, ...changes })}` })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: 'GET', url: reportUrl(randomUUID()) })).statusCode).toBe(404);
    } finally { await app.close(); }
  }, 30000);

  it('loads histories in a fixed number of database queries instead of one request per employee', async () => {
    let calls = 0;
    const datasource = new PrismaBranchAttendanceDatasource({ transaction: (operation) => database.transaction((client) => operation(new Proxy(client, {
      get(target, property, receiver) {
        if (property === 'query') return (...args: Parameters<typeof client.query>) => { calls += 1; return target.query(...args); };
        return Reflect.get(target,property,receiver);
      },
    }))) });
    const query: BranchAttendanceQuery = { ...period, branchId: mexicoId, employeeStatus: 'active', page: 1, limit: 1 };
    expect((await datasource.snapshot(query)).employees).toHaveLength(1);
    const single = calls;
    calls = 0;
    expect((await datasource.snapshot({ ...query, limit: 3 })).employees).toHaveLength(3);
    expect(calls).toBe(single);
    calls = 0;
    expect((await datasource.exportSnapshot(query)).employees).toHaveLength(3);
    expect(calls).toBe(single);
  }, 30000);

  it('exports every matching employee in one read-only snapshot, beyond the visible page', async () => {
    const users = new PrismaDeviceUserDatasource(database);
    for (const [userId,name] of [['3073','Eva'],['3074','Fernando'],['3075','Gloria'],['3076','Hugo']]) {
      await users.upsert(deviceId,{ userId, name, raw: {} });
    }
    const before = await protectedData();
    const { app } = await buildApp({ database });
    const filters = new URLSearchParams({ branchId: mexicoId, employeeStatus: 'active', ...period });
    const url = `/attendance/cards/export?${filters}`;
    try {
      const visible = (await app.inject({ method: 'GET', url: reportUrl(mexicoId,'active',1,5) })).json<BranchAttendanceCards>();
      expect(visible.cards).toHaveLength(5);
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      const exported = response.json<BranchAttendanceExport>();
      expect(exported.totalEmployees).toBe(7);
      expect(exported.cards).toHaveLength(7);
      expect(new Set(exported.cards.map((card) => card.employee.id)).size).toBe(7);
      expect(exported.cards.slice(0,5)).toEqual(visible.cards);
      expect(Number.isFinite(Date.parse(response.json().generatedAt))).toBe(true);
      const inactive = (await app.inject({ method: 'GET', url: url.replace('employeeStatus=active','employeeStatus=inactive') })).json<BranchAttendanceExport>();
      expect(inactive.cards.map((card) => card.employee.id)).toEqual([inactiveId]);
      expect((await app.inject({ method: 'GET', url: `${url}&page=2&limit=1` })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: url.replace(mexicoId,randomUUID()) })).statusCode).toBe(404);
      expect(await protectedData()).toEqual(before);
    } finally { await app.close(); }
  }, 30000);
});
