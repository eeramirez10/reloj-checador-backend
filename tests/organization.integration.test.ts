import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { PrismaOrganizationDatasource as OrganizationRepository } from '../src/infrastructure/datasources/organization-datasource.js';
import { branchSchema, type PolicySettings, type ScheduleSettings } from '../src/presentation/validators/organization.js';
import { PrismaEmployeeDatasource as EmployeeRepository } from '../src/infrastructure/datasources/employee-datasource.js';
import { PrismaDeviceDatasource as DeviceRepository } from '../src/infrastructure/datasources/device-datasource.js';
import { PrismaDeviceUserDatasource as DeviceUserRepository } from '../src/infrastructure/datasources/device-user-datasource.js';
import { PrismaAttendanceDatasource as AttendanceRepository } from '../src/infrastructure/datasources/attendance-datasource.js';
import type { AttendanceEvaluationService } from '../src/domain/use-cases/evaluate-attendance.js';
import { dateAtLocalTime } from '../src/domain/entities/schedule-evaluator.js';
import { buildApp, createAttendanceEvaluation, createEmployeeRegistry } from './helpers/build-test-app.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;

integration('organization and scheduled attendance in PostgreSQL', () => {
  const schema = `test_schedules_${randomUUID().replaceAll('-', '')}`;
  let admin: Database;
  let database: Database;
  let organization: OrganizationRepository;
  let evaluation: AttendanceEvaluationService;
  let employeeId: string;
  let firstBranchId: string;
  let secondBranchId: string;
  let firstDeviceId: string;
  let secondDeviceId: string;
  let scheduleId: string;
  const settings: ScheduleSettings = { workDays: [1, 2, 3, 4, 5, 6, 7], entryTime: '08:30', exitTime: '18:00', mealEnabled: true, mealStart: '14:00', mealEnd: '15:00', mealDurationMinutes: 60 };
  const policy: PolicySettings = { entryToleranceMinutes: 0, mealToleranceMinutes: 0, entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 };

  beforeAll(async () => {
    admin = new Database(connection!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(scoped.toString());
    await runMigrations(database);
    await runMigrations(database);
    organization = new OrganizationRepository(database);
    evaluation = createAttendanceEvaluation(database, organization);
    firstBranchId = (await organization.saveBranch(branchSchema.parse({ name: 'México', street: 'Reforma', exteriorNumber: '10', postalCode: '06000' })))!.id;
    secondBranchId = (await organization.saveBranch(branchSchema.parse({ name: 'Otra sucursal' })))!.id;
    await organization.addPolicy(firstBranchId, { effectiveFrom: '2025-01-01', settings: policy });
    scheduleId = (await organization.addSchedule({ branchId: firstBranchId, name: 'Jornada con comida', effectiveFrom: '2025-01-01', isDefault: true, settings })).id;
    await new EmployeeRepository(database).upsert({ employeeNumber: '00001517', normalizedEmployeeNumber: '1517', name: 'Empleado de prueba' });
    employeeId = (await database.query<{ id: string }>('SELECT id FROM employees')).rows[0].id;
    await organization.assignBranch(firstBranchId, { employeeIds: [employeeId], deviceUserIds: [], effectiveFrom: '2025-01-01' });
    const devices = new DeviceRepository(database);
    firstDeviceId = (await devices.create({ name: 'Reloj México', ipAddress: '127.0.0.1', branchId: firstBranchId })).id;
    secondDeviceId = (await devices.create({ name: 'Reloj otra sucursal', ipAddress: '127.0.0.2', branchId: secondBranchId })).id;
    await new DeviceUserRepository(database).upsert(firstDeviceId, { userId: '1517', name: 'Nombre original reloj', raw: {} });
    await new DeviceUserRepository(database).upsert(secondDeviceId, { userId: '1517', name: 'Otra persona', raw: {} });
    const { app } = await buildApp({ database });
    try {
      expect((await app.inject({ method: 'PUT', url: `/employees/${employeeId}/scheduling`, payload: {
        effectiveFrom: '2025-01-01', workHours: null,
        meal: { enabled: true, startTime: '14:00', endTime: '15:00', durationMinutes: 60 }, recognitionMarginMinutes: 30,
      } })).statusCode).toBe(204);
    } finally { await app.close(); }
  }, 30000);

  afterAll(async () => {
    await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  it('keeps one assigned clock, preserves historical IDs and recalculates meal tardies idempotently', async () => {
    const users = new DeviceUserRepository(database);
    expect((await users.list({ deviceId: firstDeviceId, limit: 500 }))[0].employeeId).toBe(employeeId);
    const other = (await users.list({ deviceId: secondDeviceId, limit: 500 }))[0];
    expect(other.employeeId).not.toBe(employeeId);
    expect((await new EmployeeRepository(database).findById(other.employeeId!))?.identificationStatus).toBe('pending');
    const extraDevice = await new DeviceRepository(database).create({ name: 'Segundo reloj México', ipAddress: '127.0.0.3', branchId: firstBranchId });
    await users.upsert(extraDevice.id, { userId: '01517', raw: {} });
    expect((await users.list({ deviceId: extraDevice.id, limit: 500 }))[0].employeeId).not.toBe(employeeId);
    await users.upsert(firstDeviceId, { userId: '01517', raw: {} });
    const alias = (await users.list({ deviceId: firstDeviceId, limit: 500 })).find((item) => item.userId === '01517')!;
    await createEmployeeRegistry(database, organization).identify(alias.employeeId!, { targetEmployeeId: employeeId });
    const repository = new AttendanceRepository(database);
    for (const day of ['2025-10-28', '2025-10-29', '2025-10-30', '2025-11-03']) {
      for (const [index, time] of ['08:31', '15:10', '16:11', '18:00'].entries()) {
        const device = firstDeviceId;
        await repository.insertIfNew(device, { deviceLogId: `${day}-${index}`, userId: index === 3 ? '01517' : '1517', occurredAt: dateAtLocalTime(day, time, 'America/Mexico_City'), raw: {} });
      }
    }
    expect((await evaluation.recalculate()).deductions).toBe(3);
    const first = (await database.query('SELECT id, trigger_incident_id FROM attendance_deductions WHERE voided_at IS NULL ORDER BY id')).rows;
    expect((await evaluation.recalculate()).deductions).toBe(3);
    expect((await database.query('SELECT id, trigger_incident_id FROM attendance_deductions WHERE voided_at IS NULL ORDER BY id')).rows).toEqual(first);
    const report = await evaluation.report({ from: '2025-10-28', to: '2025-11-03' });
    expect(report).toHaveLength(4);
    expect(report[0].result).toMatchObject({ status: 'complete', deductionDays: 2, counters: { arrival: 0, meal: 0 } });
    expect(report[0].result.incidents).toHaveLength(3);
    expect(report[0].result.punches.map((punch: { movement: string }) => punch.movement)).toEqual(['entry', 'meal_departure', 'meal_return', 'exit']);
    const localUser = (await users.list({ deviceId: firstDeviceId, limit: 500 }))[0];
    await organization.assignSchedule(scheduleId, { employeeIds: [], deviceUserIds: [localUser.id], effectiveFrom: '2025-01-01' });
    expect((await organization.listAssignments())[0].employeeId).toBe(employeeId);
    await users.upsert(firstDeviceId, { userId: '1517', name: 'Nombre actualizado en reloj', raw: {} });
    expect((await users.list({ deviceId: firstDeviceId, limit: 500 }))[0]).toMatchObject({ employeeId, employeeName: 'Empleado de prueba', name: 'Nombre actualizado en reloj' });
    for (const [index, time] of ['08:31', '15:10', '16:11', '18:00'].entries()) {
      await repository.insertIfNew(firstDeviceId, { deviceLogId: `earlier-${index}`, userId: '1517', occurredAt: dateAtLocalTime('2025-10-27', time, 'America/Mexico_City'), raw: {} });
    }
    await evaluation.recalculate();
    expect((await database.query('SELECT COUNT(*)::int AS count FROM attendance_deductions WHERE voided_at IS NULL')).rows[0].count).toBe(3);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM attendance_deductions WHERE voided_at IS NOT NULL')).rows[0].count).toBeGreaterThan(0);
  }, 30000);

  it('preserves branch history, validates APIs and saves address/profile fields', async () => {
    await organization.assignBranch(secondBranchId, { employeeIds: [employeeId], deviceUserIds: [], effectiveFrom: '2025-11-01' });
    await organization.assignBranch(firstBranchId, { employeeIds: [employeeId], deviceUserIds: [], effectiveFrom: '2099-01-01' });
    await evaluation.recalculate();
    const report = await evaluation.report({ from: '2025-10-28', to: '2025-11-03' });
    expect(report.find((day) => day.date === '2025-10-28')?.branchId).toBe(firstBranchId);
    expect(report.find((day) => day.date === '2025-11-03')?.branchId).toBe(secondBranchId);
    expect((await database.query('SELECT branch_id FROM employees WHERE id = $1', [employeeId])).rows[0].branch_id).toBe(secondBranchId);
    const { app } = await buildApp({ database });
    try {
      const branches = (await app.inject({ method: 'GET', url: '/branches' })).json();
      expect(branches.find((branch: { id: string }) => branch.id === firstBranchId)).toMatchObject({ street: 'Reforma', exteriorNumber: '10', postalCode: '06000' });
      expect((await app.inject({ method: 'POST', url: '/devices', payload: { name: 'Sin sucursal', ipAddress: '127.0.0.5' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/work-schedules', payload: { name: 'Inválido', branchId: firstBranchId, effectiveFrom: '2026-01-01', isDefault: false, settings: { ...settings, mealStart: '17:00', mealEnd: '15:00' } } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: `/employees/${employeeId}`, payload: { name: 'Nombre local editado', rfc: 'AAAA000101AA1' } })).statusCode).toBe(204);
      const employees = (await app.inject({ method: 'GET', url: '/employees' })).json();
      expect(employees[0]).toMatchObject({ id: employeeId, name: 'Nombre local editado', rfc: 'AAAA000101AA1' });
      expect((await app.inject({ method: 'GET', url: '/attendance/daily?from=2026-10-01&to=2026-11-04' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/attendance/daily?from=2026-11-04&to=2026-10-01' })).statusCode).toBe(400);
    } finally { await app.close(); }
  }, 30000);

  it('saves assignments atomically and restores branch work hours without clearing the individual meal', async () => {
    const before = (await database.query('SELECT COUNT(*)::int AS count FROM branch_assignments')).rows[0].count;
    await expect(organization.assign({ employeeIds: [employeeId], deviceUserIds: [], branchId: firstBranchId, scheduleId,
      effectiveFrom: '2024-01-01' })).rejects.toThrow('vigencia');
    expect((await database.query('SELECT COUNT(*)::int AS count FROM branch_assignments')).rows[0].count).toBe(before);
    await organization.addPolicy(secondBranchId, { effectiveFrom: '2025-11-01', settings: policy });
    await organization.addPolicy(secondBranchId, { effectiveFrom: '2025-11-01', settings: { ...policy, entryToleranceMinutes: 5 } });
    await organization.addSchedule({ name: 'Base sin comida', branchId: secondBranchId, effectiveFrom: '2025-11-01', isDefault: true,
      settings: { ...settings, mealEnabled: false } });
    await organization.assign({ employeeIds: [employeeId], deviceUserIds: [], scheduleId: null, effectiveFrom: '2025-11-01' });
    await evaluation.recalculate();
    const report = await evaluation.report({ from: '2025-10-28', to: '2025-11-03' });
    expect(report.find((day) => day.date === '2025-10-28')?.result.expectedMealReturn).toBeDefined();
    expect(report.find((day) => day.date === '2025-11-03')?.result).toMatchObject({ scheduleName: 'Base sin comida', scheduleSource: 'branch' });
    expect(report.find((day) => day.date === '2025-11-03')?.result.expectedMealReturn).toBeDefined();
    expect(report.find((day) => day.date === '2025-11-03')?.result.incidents.map((incident: { kind: string }) => incident.kind))
      .toEqual(['meal_departure', 'meal_return']);
  }, 30000);

  it('updates branch-local hours and daily boundaries after changing the time zone while preserving UTC instants', async () => {
    const branch = (await organization.saveBranch(branchSchema.parse({ name: 'Zona de prueba' })))!;
    const device = await new DeviceRepository(database).create({ name: 'Reloj zona horaria', ipAddress: '127.0.0.4', branchId: branch.id });
    await new DeviceUserRepository(database).upsert(device.id, { userId: '601', name: 'Persona de prueba', raw: {} });
    const occurredAt = new Date('2025-11-05T05:30:00Z');
    await new AttendanceRepository(database).insertIfNew(device.id, { deviceLogId: 'timezone-1', userId: '601', occurredAt,
      raw: { deviceLocalTime: '2025-11-04 23:30:00', deviceTimeZone: 'America/Mexico_City' } });
    await evaluation.recalculate();
    const original = await evaluation.report({ from: '2025-11-04', to: '2025-11-05', branchId: branch.id });
    expect(original).toHaveLength(1);
    expect(original[0].date).toBe('2025-11-04');
    const { app } = await buildApp({ database });
    try {
      const response = await app.inject({ method: 'PUT', url: `/branches/${branch.id}`, payload: { ...branch, timeZone: 'America/Cancun' } });
      expect(response.statusCode).toBe(200);
      expect(response.json().timeZone).toBe('America/Cancun');
      expect((await new DeviceRepository(database).findById(device.id))?.timeZone).toBe('America/Cancun');
      const updated = await evaluation.report({ from: '2025-11-04', to: '2025-11-05', branchId: branch.id });
      expect(updated).toHaveLength(1);
      expect(updated[0].date).toBe('2025-11-05');
      const summary = await app.inject({ method: 'GET', url: `/users/601/attendance-summary?deviceId=${device.id}` });
      expect(summary.statusCode).toBe(200);
      expect(summary.json().summaries[0].date).toBe('2025-11-05');
      expect(updated[0].result.timeZone).toBe('America/Cancun');
      expect(updated[0].result.punches[0].localTime).toBe('2025-11-05 00:30:00');
      const logs = await app.inject({ method: 'GET', url: `/attendance?branchId=${branch.id}&timeZone=America%2FCancun&from=2025-11-05T05:00:00Z&to=2025-11-06T04:59:59.999Z` });
      expect(logs.statusCode).toBe(200);
      expect(logs.json()).toHaveLength(1);
      expect(logs.json()[0]).toMatchObject({ occurredAt: occurredAt.toISOString(), occurredAtLocal: '2025-11-05 00:30:00', branchId: branch.id });
      expect((await database.query<{ occurred_at: Date }>('SELECT occurred_at FROM attendance_logs WHERE device_id = $1', [device.id])).rows[0].occurred_at).toEqual(occurredAt);
      expect((await app.inject({ method: 'PUT', url: `/branches/${branch.id}`, payload: { ...branch, timeZone: 'Invalid/Zone' } })).statusCode).toBe(400);
      expect((await new DeviceRepository(database).findById(device.id))?.timeZone).toBe('America/Cancun');
      expect((await app.inject({ method: 'PUT', url: `/branches/${branch.id}`, payload: branch })).statusCode).toBe(200);
      const restored = await evaluation.report({ from: '2025-11-04', to: '2025-11-05', branchId: branch.id });
      expect(restored).toHaveLength(1);
      expect(restored[0].id).toBe(original[0].id);
    } finally { await app.close(); }
  }, 30000);

  it('generates branch UUIDs without an imported code and preserves the identifier on edit', async () => {
    const { app } = await buildApp({ database });
    try {
      const suppliedId = randomUUID();
      const created = await app.inject({ method: 'POST', url: '/branches', payload: { id: suppliedId, code: 'IMPORTED', name: 'Sucursal propia' } });
      expect(created.statusCode).toBe(201);
      const branch = created.json();
      expect(branch.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
      expect(branch.id).not.toBe(suppliedId);
      expect(branch).not.toHaveProperty('code');
      const second = await app.inject({ method: 'POST', url: '/branches', payload: { name: 'Sucursal propia' } });
      expect(second.statusCode).toBe(201);
      expect(second.json().id).not.toBe(branch.id);
      const edited = await app.inject({ method: 'PUT', url: `/branches/${branch.id}`, payload: { ...branch, name: 'Sucursal editada', street: 'Calle propia' } });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toMatchObject({ id: branch.id, name: 'Sucursal editada', street: 'Calle propia' });
      const columns = await database.query("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'branches' AND column_name = 'code'");
      expect(columns.rows).toHaveLength(0);
      expect((await new DeviceRepository(database).findById(firstDeviceId))?.branchId).toBe(firstBranchId);
    } finally { await app.close(); }
  }, 30000);

  it('edits device name and endpoint without losing users or attendance and rejects duplicate endpoints', async () => {
    const previousLogs = (await database.query('SELECT id, event_key, device_id FROM attendance_logs WHERE device_id = $1 ORDER BY id', [firstDeviceId])).rows;
    const previousUsers = (await database.query('SELECT id, employee_id FROM device_users WHERE device_id = $1 ORDER BY id', [firstDeviceId])).rows;
    const clients = { getClient: () => ({ testConnection: async (device: { ipAddress: string; tcpPort: number }) => ({ raw: { ipAddress: device.ipAddress, port: device.tcpPort } }) }) };
    const { app } = await buildApp({ database, clients: clients as any });
    try {
      const edited = await app.inject({ method: 'PATCH', url: `/devices/${firstDeviceId}`, payload: { name: 'MB160 recepción', ipAddress: '127.0.0.55', tcpPort: 4371, syncIntervalSeconds: 120, enabled: false } });
      expect(edited.statusCode).toBe(200);
      expect(edited.json()).toMatchObject({ id: firstDeviceId, name: 'MB160 recepción', ipAddress: '127.0.0.55', tcpPort: 4371, branchId: firstBranchId, syncIntervalSeconds: 120, enabled: false });
      const tested = await app.inject({ method: 'POST', url: `/devices/${firstDeviceId}/test-connection` });
      expect(tested.statusCode).toBe(200);
      expect(tested.json().raw).toEqual({ ipAddress: '127.0.0.55', port: 4371 });
      expect((await app.inject({ method: 'PATCH', url: `/devices/${firstDeviceId}`, payload: { ipAddress: '127.0.0.2', tcpPort: 4370 } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'PATCH', url: `/devices/${firstDeviceId}`, payload: { ipAddress: '999.1.2.3' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: `/devices/${firstDeviceId}`, payload: { tcpPort: 0 } })).statusCode).toBe(400);
      expect((await new DeviceRepository(database).findById(firstDeviceId))?.ipAddress).toBe('127.0.0.55');
      expect((await database.query('SELECT id, event_key, device_id FROM attendance_logs WHERE device_id = $1 ORDER BY id', [firstDeviceId])).rows).toEqual(previousLogs);
      expect((await database.query('SELECT id, employee_id FROM device_users WHERE device_id = $1 ORDER BY id', [firstDeviceId])).rows).toEqual(previousUsers);
    } finally { await app.close(); }
  }, 30000);

  it('edits shared personal data through Users, preserves legacy values and keeps them across clock syncs', async () => {
    const repository = new DeviceUserRepository(database);
    const user = (await repository.list({ deviceId: firstDeviceId, limit: 500 }))[0];
    const originalName = user.employeeName;
    await database.query("UPDATE employees SET imss = '1234567890' WHERE id = $1", [employeeId]);
    const { app } = await buildApp({ database });
    try {
      expect((await app.inject({ method: 'PATCH', url: `/users/${user.id}/profile`, payload: { rfc: 'pelj-900101-ab1' } })).statusCode).toBe(204);
      expect((await repository.list({ deviceId: firstDeviceId, limit: 500 }))[0]).toMatchObject({ employeeName: originalName, rfc: 'PELJ900101AB1', socialSecurityNumber: '1234567890' });
      const edited = await app.inject({ method: 'PATCH', url: `/users/${user.id}/profile`, payload: { firstName: 'María José', lastName: 'Pérez López', rfc: 'pelj-900101-ab1', socialSecurityNumber: '00123456789' } });
      expect(edited.statusCode).toBe(204);
      const shared = (await repository.list({ limit: 500 })).filter((item) => item.employeeId === employeeId);
      expect(shared.length).toBeGreaterThan(1);
      for (const item of shared) expect(item).toMatchObject({ firstName: 'María José', lastName: 'Pérez López', employeeName: 'María José Pérez López', rfc: 'PELJ900101AB1', socialSecurityNumber: '00123456789' });
      const employee = (await new EmployeeRepository(database).list({ limit: 500 })).find((item) => item.id === employeeId);
      expect(employee).toMatchObject({ firstName: 'María José', lastName: 'Pérez López', name: 'María José Pérez López', imss: '00123456789' });
      await repository.upsert(firstDeviceId, { userId: '1517', name: 'Nombre que envía el reloj', raw: {} });
      expect((await repository.list({ deviceId: firstDeviceId, limit: 500 }))[0]).toMatchObject({ name: 'Nombre que envía el reloj', employeeName: 'María José Pérez López', rfc: 'PELJ900101AB1', socialSecurityNumber: '00123456789' });
      expect((await app.inject({ method: 'PATCH', url: `/employees/${employeeId}`, payload: { lastName: 'Pérez Morales' } })).statusCode).toBe(204);
      expect((await repository.list({ deviceId: firstDeviceId, limit: 500 }))[0].employeeName).toBe('María José Pérez Morales');
      const logs = (await app.inject({ method: 'GET', url: `/attendance?deviceId=${firstDeviceId}` })).json();
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.every((log: { userName: string }) => log.userName === 'María José Pérez Morales')).toBe(true);
      expect((await app.inject({ method: 'PATCH', url: `/users/${user.id}/profile`, payload: { socialSecurityNumber: '1234567890' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: `/users/${user.id}/profile`, payload: { rfc: 'INVALIDO' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'PATCH', url: `/users/${user.id}/profile`, payload: { employeeId: null, firstName: null, lastName: 'Sin nombre' } })).statusCode).toBe(400);
      expect((await repository.list({ deviceId: firstDeviceId, limit: 500 }))[0]).toMatchObject({ employeeId, socialSecurityNumber: '00123456789', employeeName: 'María José Pérez Morales' });
    } finally { await app.close(); }
  }, 30000);

  it('keeps pending personal data in one employee record and archives it when resolving an identity', async () => {
    const repository = new DeviceUserRepository(database);
    const user = (await repository.list({ deviceId: secondDeviceId, limit: 500 }))[0];
    const { app } = await buildApp({ database });
    try {
      expect((await app.inject({ method: 'PATCH', url: `/users/${user.id}/profile`, payload: { firstName: 'Luis', lastName: 'García', rfc: 'gall900101abc', socialSecurityNumber: '00000000001' } })).statusCode).toBe(204);
      expect((await repository.list({ deviceId: secondDeviceId, limit: 500 }))[0]).toMatchObject({ name: 'Otra persona', employeeName: 'Luis García', firstName: 'Luis', lastName: 'García', rfc: 'GALL900101ABC', socialSecurityNumber: '00000000001' });
      await repository.upsert(secondDeviceId, { userId: '1517', name: 'Reloj actualizado', raw: {} });
      expect((await repository.list({ deviceId: secondDeviceId, limit: 500 }))[0].employeeName).toBe('Luis García');
      expect((await app.inject({ method: 'PATCH', url: `/users/${user.id}/profile`, payload: { employeeId } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: `/employees/${user.employeeId}/identify`, payload: { targetEmployeeId: employeeId, useAsAssignedClock: true } })).statusCode).toBe(200);
      expect((await repository.list({ deviceId: secondDeviceId, limit: 500 }))[0]).toMatchObject({ employeeId, firstName: 'María José', lastName: 'Pérez Morales', socialSecurityNumber: '00123456789' });
      expect((await app.inject({ method: 'PATCH', url: `/users/${user.id}/profile`, payload: { employeeId: null } })).statusCode).toBe(400);
      const original = await new EmployeeRepository(database).findById(user.employeeId!);
      expect(original).toMatchObject({ identificationStatus: 'merged', mergedIntoId: employeeId, firstName: 'Luis', lastName: 'García', imss: '00000000001' });
      const history = await createEmployeeRegistry(database, organization).history(employeeId);
      expect(history.merges.some((event) => event.originalData.source.imss === '00000000001')).toBe(true);
      expect((await new EmployeeRepository(database).list({ limit: 500 })).find((item) => item.id === employeeId)?.imss).toBe('00123456789');
    } finally { await app.close(); }
  }, 30000);
});
