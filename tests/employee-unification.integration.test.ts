import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { PrismaEmployeeDatasource as EmployeeRepository } from '../src/infrastructure/datasources/employee-datasource.js';
import type { EmployeeRegistry } from '../src/domain/use-cases/manage-employee-registry.js';
import { PrismaOrganizationDatasource as OrganizationRepository } from '../src/infrastructure/datasources/organization-datasource.js';
import type { AttendanceEvaluationService } from '../src/domain/use-cases/evaluate-attendance.js';
import { dateAtLocalTime, evaluateDay } from '../src/domain/entities/schedule-evaluator.js';
import type { PolicySettings, ScheduleSettings } from '../src/domain/entities/organization.js';
import { PrismaDeviceDatasource as DeviceRepository } from '../src/infrastructure/datasources/device-datasource.js';
import { PrismaDeviceUserDatasource as DeviceUserRepository } from '../src/infrastructure/datasources/device-user-datasource.js';
import { createAttendanceEvaluation, createEmployeeRegistry } from '../src/main.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;

integration('lossless employee unification', () => {
  const schema = `test_unification_${randomUUID().replaceAll('-', '')}`;
  const branchId = randomUUID();
  const deviceId = randomUUID();
  const employeeId = randomUUID();
  const confirmedRecordId = randomUUID();
  const pendingRecordId = randomUUID();
  const policyId = randomUUID();
  const scheduleId = randomUUID();
  const deductionId = randomUUID();
  const incidentIds: string[] = [];
  const evaluationIds: string[] = [];
  const photoBytes = Buffer.from([255, 216, 12, 34, 56, 255, 217]);
  let admin: Database;
  let database: Database;
  let organization: OrganizationRepository;
  let registry: EmployeeRegistry;
  let evaluation: AttendanceEvaluationService;
  let originalLogs: unknown[];
  let originalRecord: Record<string, unknown>;
  let originalEmployee: Record<string, unknown>;
  const policy: PolicySettings = { entryToleranceMinutes: 0, mealToleranceMinutes: 0, entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 };
  const settings: ScheduleSettings = { workDays: [1, 2, 3, 4, 5, 6, 7], entryTime: '08:30', exitTime: '18:00', mealEnabled: false, mealStart: '14:00', mealEnd: '15:00', mealDurationMinutes: 60 };

  beforeAll(async () => {
    admin = new Database(connection!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(scoped.toString());
    await runMigrations(database, '008_native_identifiers_and_profiles.sql');
    await database.query("INSERT INTO branches (id,name) VALUES ($1,'Sucursal de prueba')", [branchId]);
    await database.query("INSERT INTO devices (id,name,ip_address,branch_id) VALUES ($1,'Reloj original','127.0.0.1',$2)", [deviceId, branchId]);
    await database.query(`INSERT INTO employees (id,employee_number,normalized_employee_number,name,rfc,imss,branch_id)
      VALUES ($1,'00000042','42','Nombre confirmado','AAAA000101AAA','00123456789',$2)`, [employeeId, branchId]);
    await database.query(`INSERT INTO device_users (id,device_id,device_user_id,name,raw_data,employee_id,branch_id)
      VALUES ($1,$2,'42','Nombre original reloj','{"original":true}',$3,$4)`, [confirmedRecordId, deviceId, employeeId, branchId]);
    await database.query(`INSERT INTO device_users (id,device_id,device_user_id,name,display_name,first_name,last_name,rfc,imss,card_number,raw_data,branch_id)
      VALUES ($1,$2,'501','Nombre del reloj pendiente','Nombre local capturado','Nombre local','Apellido','BBBB000101BBB','00001234567','000123','{"original":true,"uid":99}',$3)`, [pendingRecordId, deviceId, branchId]);
    await database.query("INSERT INTO device_user_photos (device_id,device_user_id,content_type,image_data) VALUES ($1,'501','image/jpeg',$2)", [deviceId, photoBytes]);
    await database.query("INSERT INTO branch_assignments (id,device_user_id,branch_id,effective_from) VALUES ($1,$2,$3,'1900-01-01')", [randomUUID(), pendingRecordId, branchId]);
    await database.query("INSERT INTO branch_policies (id,branch_id,effective_from,settings) VALUES ($1,$2,'2025-01-01',$3)", [policyId, branchId, JSON.stringify(policy)]);
    await database.query("INSERT INTO work_schedules (id,branch_id,name,effective_from,is_default,settings) VALUES ($1,$2,'Jornada original','2025-01-01',TRUE,$3)", [scheduleId, branchId, JSON.stringify(settings)]);
    await database.query("INSERT INTO schedule_assignments (id,device_user_id,schedule_id,effective_from) VALUES ($1,$2,$3,'2025-01-01')", [randomUUID(), pendingRecordId, scheduleId]);
    for (const day of ['2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04']) {
      const logs = ['08:31', '18:00'].map((time) => ({ id: randomUUID(), occurredAt: dateAtLocalTime(day, time, 'America/Mexico_City') }));
      for (const log of logs) await database.query(`INSERT INTO attendance_logs (id,device_id,event_key,device_log_id,user_id,occurred_at,raw_data,branch_id)
        VALUES ($1::uuid,$2,($1::uuid)::text,($1::uuid)::text,'501',$3,'{"original":true}',$4)`, [log.id, deviceId, log.occurredAt, branchId]);
      const daily = evaluateDay(day, logs, settings, policy, 'America/Mexico_City', new Date('2025-10-05T12:00:00Z'));
      const evaluationId = randomUUID();
      const incidentId = randomUUID();
      evaluationIds.push(evaluationId);
      incidentIds.push(incidentId);
      await database.query(`INSERT INTO attendance_evaluations (id,subject_id,device_user_id,date,branch_id,policy_id,schedule_id,result)
        VALUES ($1,$2,$2,$3,$4,$5,$6,$7)`, [evaluationId, pendingRecordId, day, branchId, policyId, scheduleId, JSON.stringify(daily)]);
      await database.query(`INSERT INTO attendance_incidents (id,evaluation_id,subject_id,policy_id,log_id,kind,occurred_at,minutes)
        VALUES ($1,$2,$3,$4,$5,'arrival',$6,1)`, [incidentId, evaluationId, pendingRecordId, policyId, logs[0].id, logs[0].occurredAt]);
    }
    await database.query(`INSERT INTO attendance_deductions (id,subject_id,policy_id,trigger_incident_id,category,window_start,window_end,incident_ids)
      VALUES ($1,$2,$3,$4,'arrival','2025-10-01','2025-10-31',$5)`, [deductionId, pendingRecordId, policyId, incidentIds.at(-1), incidentIds]);
    originalLogs = (await database.query('SELECT to_jsonb(a) AS record FROM attendance_logs a ORDER BY id')).rows;
    originalRecord = (await database.query('SELECT to_jsonb(u) AS record FROM device_users u WHERE id = $1', [pendingRecordId])).rows[0].record;
    originalEmployee = (await database.query('SELECT to_jsonb(e) AS record FROM employees e WHERE id = $1', [employeeId])).rows[0].record;
    organization = new OrganizationRepository(database);
    registry = createEmployeeRegistry(database, organization);
    evaluation = createAttendanceEvaluation(database, organization);
  }, 30000);

  afterAll(async () => {
    await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  it('migrates pending identities with the same UUIDs, photos, original data, assignments and deduction IDs', async () => {
    await runMigrations(database);
    const employees = await new EmployeeRepository(database).list({ limit: 500 });
    expect(employees).toHaveLength(2);
    const pending = employees.find((item) => item.id === pendingRecordId)!;
    expect(pending).toMatchObject({ identificationStatus: 'pending', name: 'Nombre local capturado', firstName: 'Nombre local', lastName: 'Apellido', imss: '00001234567', rfc: 'BBBB000101BBB' });
    expect(pending.employeeNumber).toBeUndefined();
    expect(pending.clockRecords[0]).toMatchObject({ id: pendingRecordId, userId: '501', hasPhoto: true, cardNumber: '000123' });
    expect(Buffer.from((await database.query('SELECT image_data FROM device_user_photos')).rows[0].image_data)).toEqual(photoBytes);
    expect((await database.query('SELECT to_jsonb(a) AS record FROM attendance_logs a ORDER BY id')).rows).toEqual(originalLogs);
    const snapshot = (await database.query("SELECT record - 'binding_status' AS record FROM employee_unification_snapshots WHERE source_type='device_user' AND source_id=$1", [pendingRecordId])).rows[0].record;
    expect(snapshot).toEqual(originalRecord);
    const preserved = (await database.query("SELECT to_jsonb(e) - 'identification_status' - 'merged_into_id' - 'is_active' - 'original_name' - 'name_split_method' AS record FROM employees e WHERE id=$1", [employeeId])).rows[0].record;
    expect(preserved).toEqual({ ...originalEmployee,company_id: null,discarded_at: null });
    expect((await database.query('SELECT COUNT(*)::int AS count FROM schedule_assignments WHERE employee_id=$1', [pendingRecordId])).rows[0].count).toBe(1);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM schedule_assignments WHERE device_user_id=$1', [pendingRecordId])).rows[0].count).toBe(1);
    expect((await database.query('SELECT employee_id,device_user_id FROM attendance_evaluations WHERE id=ANY($1::uuid[])', [evaluationIds])).rows.every((row) => row.employee_id === pendingRecordId && row.device_user_id === null)).toBe(true);
    expect((await evaluation.recalculate()).deductions).toBe(1);
    expect((await database.query('SELECT id,voided_at FROM attendance_deductions')).rows).toEqual([{ id: deductionId, voided_at: null }]);
    expect((await database.query('SELECT id FROM attendance_incidents WHERE active ORDER BY id')).rows.map((row) => row.id).sort()).toEqual([...incidentIds].sort());
    const snapshotCount = (await database.query('SELECT COUNT(*)::int AS count FROM employee_unification_snapshots')).rows[0].count;
    await runMigrations(database);
    expect((await new EmployeeRepository(database).list({ limit: 500 }))).toHaveLength(2);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM employee_unification_snapshots')).rows[0].count).toBe(snapshotCount);
  }, 30000);

  it('associates a verified identity without deleting original profiles, photos, raw logs or payroll history', async () => {
    expect(await registry.identify(pendingRecordId, { targetEmployeeId: employeeId })).toBe(employeeId);
    await evaluation.recalculate();
    expect(await new EmployeeRepository(database).list({ limit: 500 })).toHaveLength(1);
    const employee = await new EmployeeRepository(database).findById(employeeId);
    expect(employee).toMatchObject({ name: 'Nombre confirmado', rfc: 'AAAA000101AAA', imss: '00123456789' });
    expect(employee!.clockRecords).toHaveLength(2);
    const stored = await database.prisma.employees.findUnique({ where: { id: employeeId }, include: { device_users: true } });
    expect(stored!.device_users).toHaveLength(2);
    expect(employee!.clockRecords.filter((record) => record.bindingStatus === 'active')).toHaveLength(1);
    expect((await new EmployeeRepository(database).findById(pendingRecordId))).toMatchObject({ identificationStatus: 'merged', mergedIntoId: employeeId, imss: '00001234567' });
    const history = await registry.history(employeeId);
    expect(history.merges[0].originalData.source.imss).toBe('00001234567');
    expect(Buffer.from((await database.query('SELECT image_data FROM device_user_photos')).rows[0].image_data)).toEqual(photoBytes);
    expect((await database.query('SELECT to_jsonb(a) AS record FROM attendance_logs a ORDER BY id')).rows).toEqual(originalLogs);
    expect((await database.query('SELECT id FROM attendance_deductions WHERE id=$1', [deductionId])).rows).toHaveLength(1);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM attendance_deductions WHERE voided_at IS NULL')).rows[0].count).toBe(1);
    await evaluation.recalculate();
    expect((await database.query('SELECT COUNT(*)::int AS count FROM attendance_deductions WHERE voided_at IS NULL')).rows[0].count).toBe(1);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM employees')).rows[0].count).toBe(2);
  }, 30000);

  it('creates native UUID employees and rejects assigning a clock from another branch', async () => {
    const other = (await organization.saveBranch({ name: 'Otra sucursal', street: '', exteriorNumber: '', interiorNumber: '', neighborhood: '', postalCode: '', city: '', state: '', country: 'México', phone: '', email: '', managerName: '', timeZone: 'America/Mexico_City', active: true, notes: '' }))!;
    const clock = await new DeviceRepository(database).create({ name: 'Otro reloj', ipAddress: '127.0.0.2', branchId: other.id });
    const users = new DeviceUserRepository(database);
    await users.upsert(clock.id, { userId: '42', name: 'Otra persona', raw: {} });
    const pending = (await users.list({ deviceId: clock.id, limit: 500 }))[0];
    expect(pending.employeeId).not.toBe(employeeId);
    await expect(registry.assignClock(employeeId, pending.id)).rejects.toThrow('misma sucursal');
    const id = await registry.create({ firstName: 'Persona', lastName: 'Nueva', branchId: other.id, socialSecurityNumber: '00000000001' });
    const created = await new EmployeeRepository(database).findById(id);
    expect(created).toMatchObject({ name: 'Persona Nueva', identificationStatus: 'confirmed', imss: '00000000001' });
    expect(created!.employeeNumber).toBeUndefined();
    await registry.assignClock(id, pending.id);
    expect((await new EmployeeRepository(database).findById(id))!.clockRecords[0].deviceId).toBe(clock.id);
  }, 30000);
});
