import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './helpers/build-test-app.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { importEmployeeClockBindings, previewEmployeeClockBindings, type EmployeeCardRow } from '../src/infrastructure/imports/employee-clock-bindings.js';
import { PrismaDeviceUserDatasource } from '../src/infrastructure/datasources/device-user-datasource.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;

integration('employee bindings from payroll card IDs', () => {
  const schema = `test_employee_cards_${randomUUID().replaceAll('-', '')}`;
  let admin: Database; let database: Database; let services: Awaited<ReturnType<typeof buildApp>>;
  let sequence = 0;

  beforeAll(async () => {
    admin = new Database(connection!); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!); scoped.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(scoped.toString()); await runMigrations(database);
    services = await buildApp({ database });
  }, 30000);
  afterAll(async () => {
    await services?.app.close(); await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  async function fixture() {
    const offset = sequence++ * 10000;
    const branchId = randomUUID(); const deviceId = randomUUID();
    const aaronId = randomUUID(); const miguelId = randomUUID();
    const aaronNumber = String(offset + 515).padStart(8, '0'); const miguelNumber = String(offset + 519).padStart(8, '0');
    const firstCard = String(offset + 515); const secondCard = String(offset + 510);
    const firstClock = randomUUID(); const secondClock = randomUUID();
    await database.query('INSERT INTO branches (id,name) VALUES ($1,$2)', [branchId, `Sucursal ${sequence}`]);
    await database.query('INSERT INTO devices (id,name,ip_address,branch_id) VALUES ($1,$2,$3,$4)', [deviceId, `Reloj ${sequence}`, `127.1.0.${sequence}`, branchId]);
    for (const [id, number, name] of [[aaronId, aaronNumber, 'AARON TREJO LOZANO'], [miguelId, miguelNumber, 'MIGUEL ANGEL QUINTERO CARREON']]) {
      await database.query(`INSERT INTO employees (id,employee_number,normalized_employee_number,name,first_name,branch_id,rfc)
        VALUES ($1,$2,$3,$4,$4,$5,'PERSONAL-DATA')`, [id, number, String(Number(number)), name, branchId]);
      await database.query("INSERT INTO branch_assignments (id,employee_id,branch_id,effective_from) VALUES ($1,$2,$3,'1900-01-01')", [randomUUID(), id, branchId]);
    }
    for (const [id, card, owner] of [[firstClock, firstCard, aaronId], [secondClock, secondCard, miguelId]]) {
      await database.query(`INSERT INTO device_users (id,device_id,device_user_id,employee_id,branch_id,raw_data)
        VALUES ($1,$2,$3,$4,$5,'{"original":true}')`, [id, deviceId, card, owner, branchId]);
    }
    for (const time of ['14:30:00', '23:30:00']) await database.query(`INSERT INTO attendance_logs
      (id,device_id,event_key,user_id,occurred_at,raw_data,branch_id) VALUES ($1,$2,$3,$4,$5,'{"original":true}',$6)`,
    [randomUUID(), deviceId, randomUUID(), firstCard, new Date(`2026-10-20T${time}Z`), branchId]);
    await database.query(`INSERT INTO device_user_photos (device_id,device_user_id,content_type,image_data)
      VALUES ($1,$2,'image/jpeg',decode('ffd8ffe000104a4649460001ffd9','hex'))`, [deviceId, firstCard]);
    const rows: EmployeeCardRow[] = [
      { employeeNumber: aaronNumber, cardNumber: secondCard.padStart(8, '0'), name: 'TREJO LOZANO AARON', line: 2 },
      { employeeNumber: miguelNumber, cardNumber: firstCard.padStart(8, '0'), name: 'QUINTERO CARREON MIGUEL ANGEL', line: 3 },
    ];
    const input = { sourceName: 'Employees.xlsx', sourceHash: 'a'.repeat(64), rows };
    return { branchId, deviceId, aaronId, miguelId, aaronNumber, miguelNumber, firstCard, secondCard, firstClock, secondClock, rows, input };
  }

  async function records(table: string, column: string, id: string) {
    return (await database.query(`SELECT to_jsonb(t) AS record FROM ${table} t WHERE ${column}=$1 ORDER BY to_jsonb(t)::text`, [id])).rows;
  }

  it('previews a crossed binding without changing any employee or clock record', async () => {
    const f = await fixture(); const before = await records('device_users', 'device_id', f.deviceId);
    const preview = await previewEmployeeClockBindings(database, f.rows);
    expect(preview).toHaveLength(2); expect(preview.every((row) => row.changed)).toBe(true);
    expect(preview.find((row) => row.cardNumber === f.firstCard)).toMatchObject({ employeeId: f.miguelId, previousEmployeeId: f.aaronId });
    expect(await records('device_users', 'device_id', f.deviceId)).toEqual(before);
  });

  it('swaps confirmed owners as a batch and corrects historical cards without changing original logs, photos or profiles', async () => {
    const f = await fixture(); await services.evaluation.recalculate();
    const logs = await records('attendance_logs', 'device_id', f.deviceId);
    const photos = await records('device_user_photos', 'device_id', f.deviceId);
    const employee = await records('employees', 'id', f.miguelId);
    const oldEvaluation = (await database.query('SELECT id FROM attendance_evaluations WHERE employee_id=$1', [f.aaronId])).rows[0].id;
    expect((await importEmployeeClockBindings(database, f.input)).changedCount).toBe(2);
    await services.evaluation.recalculate();
    const card = await services.app.inject({ method: 'GET', url: `/employees/${f.miguelId}/attendance?from=2026-10-20&to=2026-10-20` });
    expect(card.statusCode, card.body).toBe(200);
    expect(card.json().days[0].punches).toHaveLength(2);
    const daily = (await services.app.inject({ method: 'GET', url: `/attendance/daily?branchId=${f.branchId}&from=2026-10-20&to=2026-10-20` })).json();
    expect(daily).toHaveLength(1); expect(daily[0].employeeId).toBe(f.miguelId);
    expect(daily[0].result.name).toBe('MIGUEL ANGEL QUINTERO CARREON');
    expect((await database.query('SELECT active FROM attendance_evaluations WHERE id=$1', [oldEvaluation])).rows[0].active).toBe(false);
    expect(await records('attendance_logs', 'device_id', f.deviceId)).toEqual(logs);
    expect(await records('device_user_photos', 'device_id', f.deviceId)).toEqual(photos);
    expect(await records('employees', 'id', f.miguelId)).toEqual(employee);
  });

  it('is idempotent and retains the explicit binding after a native user synchronization', async () => {
    const f = await fixture(); const result = await importEmployeeClockBindings(database, f.input);
    const audit = await records('employee_clock_binding_imports', 'id', result.importId!);
    expect(audit).toHaveLength(1);
    expect((await importEmployeeClockBindings(database, f.input)).changedCount).toBe(0);
    await new PrismaDeviceUserDatasource(database).upsert(f.deviceId, { userId: f.firstCard, name: 'Miguel', raw: { synchronized: true } });
    const owner = (await database.query('SELECT employee_id FROM device_users WHERE id=$1', [f.firstClock])).rows[0].employee_id;
    expect(owner).toBe(f.miguelId);
    expect(await records('employee_clock_binding_imports', 'id', result.importId!)).toEqual(audit);
  });

  it('requires an explicit clock when the same numeric ID exists in different branches', async () => {
    const f = await fixture(); const otherBranch = randomUUID(); const otherDevice = randomUUID();
    const otherEmployee = randomUUID(); const otherClock = randomUUID();
    await database.query("INSERT INTO branches (id,name) VALUES ($1,'Otra sucursal')", [otherBranch]);
    await database.query("INSERT INTO devices (id,name,ip_address,branch_id) VALUES ($1,'Otro reloj','127.1.2.1',$2)", [otherDevice, otherBranch]);
    await database.query("INSERT INTO employees (id,name,branch_id,identification_status) VALUES ($1,'Otra persona',$2,'pending')", [otherEmployee, otherBranch]);
    await database.query("INSERT INTO device_users (id,device_id,device_user_id,employee_id,branch_id,raw_data) VALUES ($1,$2,$3,$4,$5,'{}')",
      [otherClock, otherDevice, f.firstCard, otherEmployee, otherBranch]);
    const original = await records('device_users', 'id', otherClock);
    await expect(importEmployeeClockBindings(database, f.input)).rejects.toThrow('registros posibles');
    const overrides = new Map([[String(Number(f.miguelNumber)), f.deviceId]]);
    expect((await importEmployeeClockBindings(database, { ...f.input, overrides })).changedCount).toBe(2);
    expect(await records('device_users', 'id', otherClock)).toEqual(original);
  });

  it('archives a pending duplicate and corrects an erroneous initial branch while retaining its original evidence', async () => {
    const f = await fixture(); const pending = randomUUID(); const wrongBranch = randomUUID();
    await database.query("INSERT INTO branches (id,name) VALUES ($1,'Sucursal importada incorrectamente')", [wrongBranch]);
    await database.query("INSERT INTO employees (id,name,branch_id,identification_status) VALUES ($1,'Registro sin identificar',$2,'pending')", [pending, f.branchId]);
    await database.query('UPDATE device_users SET employee_id=$2 WHERE id=$1', [f.firstClock, pending]);
    await database.query('UPDATE employees SET branch_id=$2 WHERE id=$1', [f.miguelId, wrongBranch]);
    await database.query('UPDATE branch_assignments SET branch_id=$2 WHERE employee_id=$1', [f.miguelId, wrongBranch]);
    const result = await importEmployeeClockBindings(database, f.input);
    expect(result.changedCount).toBe(2);
    expect((await database.query('SELECT identification_status,merged_into_id FROM employees WHERE id=$1', [pending])).rows[0])
      .toEqual({ identification_status: 'merged', merged_into_id: f.miguelId });
    expect((await database.query('SELECT branch_id FROM branch_assignments WHERE employee_id=$1', [f.miguelId])).rows[0].branch_id).toBe(f.branchId);
    const audit = (await database.query('SELECT original_data FROM employee_clock_binding_imports WHERE id=$1', [result.importId])).rows[0].original_data;
    expect(audit.employees.find((employee: { id: string }) => employee.id === f.miguelId).branch_id).toBe(wrongBranch);
    expect((await database.query('SELECT id FROM employee_merge_events WHERE source_employee_id=$1', [pending])).rows).toHaveLength(1);
  });

  it('rolls back the entire permutation and its audit when a later update fails', async () => {
    const f = await fixture(); const before = await records('device_users', 'device_id', f.deviceId);
    const auditCount = (await database.query('SELECT count(*)::int AS count FROM employee_clock_binding_imports')).rows[0].count;
    await database.executeScript(`CREATE FUNCTION reject_binding() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced binding failure'; END; $$;
      CREATE TRIGGER reject_binding BEFORE UPDATE ON device_users FOR EACH ROW
      WHEN (OLD.id='${f.firstClock}'::uuid AND NEW.employee_id IS DISTINCT FROM OLD.employee_id) EXECUTE FUNCTION reject_binding();`);
    try {
      await expect(importEmployeeClockBindings(database, f.input)).rejects.toThrow('forced binding failure');
      expect(await records('device_users', 'device_id', f.deviceId)).toEqual(before);
      expect((await database.query('SELECT count(*)::int AS count FROM employee_clock_binding_imports')).rows[0].count).toBe(auditCount);
    } finally { await database.executeScript('DROP TRIGGER reject_binding ON device_users; DROP FUNCTION reject_binding();'); }
  });

  it('rejects duplicated file rows and a historical branch transfer without partially applying other rows', async () => {
    const f = await fixture(); const before = await records('device_users', 'device_id', f.deviceId);
    await expect(importEmployeeClockBindings(database, { ...f.input, rows: [...f.rows, f.rows[0]] })).rejects.toThrow('repetidos');
    const wrongBranch = randomUUID(); await database.query("INSERT INTO branches (id,name) VALUES ($1,'Sucursal anterior')", [wrongBranch]);
    await database.query('UPDATE employees SET branch_id=$2 WHERE id=$1', [f.miguelId, wrongBranch]);
    await database.query("INSERT INTO branch_assignments (id,employee_id,branch_id,effective_from) VALUES ($1,$2,$3,'2026-10-01')", [randomUUID(), f.miguelId, wrongBranch]);
    await expect(importEmployeeClockBindings(database, f.input)).rejects.toThrow('traslados históricos');
    expect(await records('device_users', 'device_id', f.deviceId)).toEqual(before);
  });
});
