import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../database/database.js';
import { PrismaEmployeeRegistrySession } from '../datasources/employee-registry-datasource.js';

export interface EmployeeCardRow { employeeNumber: string; cardNumber: string; name: string; line: number }
export interface EmployeeClockBinding {
  employeeNumber: string; name: string; cardNumber: string; employeeId: string; deviceId: string;
  branchId: string; branchName: string; clockRecordId: string; previousEmployeeId: string;
  previousEmployeeName: string; previousEmployeeStatus: string; previousClockId: string | null;
  correctInitialBranch: boolean; changed: boolean;
}
interface EmployeeRow {
  id: string; employee_number: string | null; name: string; identification_status: string; branch_id: string | null;
}
interface ClockRow {
  id: string; device_id: string; device_user_id: string; employee_id: string; binding_status: string;
  branch_id: string; branch_name: string;
}

export function normalizeCardNumber(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error(`Identificador inválido: ${value}.`);
  return value.replace(/^0+/, '') || '0';
}

export async function previewEmployeeClockBindings(database: Queryable, rows: EmployeeCardRow[], overrides: ReadonlyMap<string, string> = new Map()): Promise<EmployeeClockBinding[]> {
  if (!rows.length) throw new Error('El archivo no contiene empleados.');
  const employees = (await database.query<EmployeeRow>('SELECT id,employee_number,name,identification_status,branch_id FROM employees')).rows;
  const clocks = (await database.query<ClockRow>(`SELECT u.id,u.device_id,u.device_user_id,u.employee_id,u.binding_status,
    d.branch_id,b.name AS branch_name FROM device_users u JOIN devices d ON d.id=u.device_id
    JOIN branches b ON b.id=d.branch_id WHERE d.deleted_at IS NULL`)).rows;
  const usedEmployees = new Set<string>(); const usedClocks = new Set<string>();
  const bindings = rows.map((row) => {
    const number = normalizeCardNumber(row.employeeNumber); const card = normalizeCardNumber(row.cardNumber);
    const matches = employees.filter((employee) => employee.employee_number !== null && normalizeCardNumber(employee.employee_number) === number);
    if (matches.length !== 1 || matches[0].identification_status !== 'confirmed') throw new Error(`Fila ${row.line}: empleado ${row.employeeNumber} no identificado de forma única.`);
    const employee = matches[0];
    const override = overrides.get(number);
    const candidates = clocks.filter((clock) => /^\d+$/.test(clock.device_user_id) && normalizeCardNumber(clock.device_user_id) === card && (!override || clock.device_id === override));
    if (candidates.length !== 1) throw new Error(`Fila ${row.line}: tarjeta ${card} tiene ${candidates.length} registros posibles. Especifica su reloj con --device-override.`);
    const clock = candidates[0]; const owner = employees.find((item) => item.id === clock.employee_id)!;
    if (usedEmployees.has(employee.id) || usedClocks.has(clock.id)) throw new Error(`Fila ${row.line}: empleado o tarjeta repetidos para el mismo reloj.`);
    usedEmployees.add(employee.id); usedClocks.add(clock.id);
    const current = clocks.find((item) => item.employee_id === employee.id && item.binding_status === 'active');
    return { employeeNumber: row.employeeNumber, name: employee.name, cardNumber: card, employeeId: employee.id,
      deviceId: clock.device_id, branchId: clock.branch_id, branchName: clock.branch_name, clockRecordId: clock.id,
      previousEmployeeId: owner.id, previousEmployeeName: owner.name, previousEmployeeStatus: owner.identification_status,
      previousClockId: current?.id ?? null, correctInitialBranch: employee.branch_id !== clock.branch_id,
      changed: owner.id !== employee.id || clock.binding_status !== 'active' || employee.branch_id !== clock.branch_id };
  });
  const changedClocks = new Set(bindings.filter((row) => row.changed).map((row) => row.clockRecordId));
  for (const row of bindings.filter((item) => item.changed)) {
    if (row.previousClockId && row.previousClockId !== row.clockRecordId && !changedClocks.has(row.previousClockId)) {
      throw new Error(`El empleado ${row.employeeNumber} tiene otro reloj activo fuera de esta conciliación.`);
    }
    if (row.previousEmployeeStatus === 'pending' && clocks.some((clock) => clock.employee_id === row.previousEmployeeId && clock.id !== row.clockRecordId)) {
      throw new Error(`La ficha pendiente de la tarjeta ${row.cardNumber} tiene otros registros; requiere revisión individual.`);
    }
    if (row.correctInitialBranch) {
      const assignments = (await database.query<{ effective_from: string }>('SELECT effective_from::text FROM branch_assignments WHERE employee_id=$1', [row.employeeId])).rows;
      if (assignments.length > 1 || assignments.some((item) => item.effective_from !== '1900-01-01')) {
        throw new Error(`El empleado ${row.employeeNumber} tiene traslados históricos; no se puede corregir su sucursal inicial automáticamente.`);
      }
    }
  }
  return bindings;
}

async function originalData(database: Queryable, bindings: EmployeeClockBinding[]) {
  const employeeIds = [...new Set(bindings.flatMap((row) => [row.employeeId, row.previousEmployeeId]))];
  const clockIds = bindings.map((row) => row.clockRecordId);
  const snapshot: Record<string, unknown> = {};
  for (const table of ['employees', 'device_users', 'branch_assignments', 'schedule_assignments', 'employee_schedule_versions']) {
    const column = table === 'employees' || table === 'device_users' ? 'id' : 'employee_id';
    const ids = table === 'device_users' ? clockIds : employeeIds;
    snapshot[table] = (await database.query(`SELECT to_jsonb(t) AS record FROM ${table} t WHERE ${column}=ANY($1::uuid[])`, [ids])).rows.map((row) => row.record);
  }
  return snapshot;
}

export async function importEmployeeClockBindings(database: Database, input: {
  sourceName: string; sourceHash: string; rows: EmployeeCardRow[]; overrides?: ReadonlyMap<string, string>;
}) {
  return database.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('attendance-evaluation'))::text");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-identification'))::text");
    // Las permutaciones de empleados se validan y aplican como un solo lote.
    await client.query('SELECT id FROM employees ORDER BY id FOR UPDATE');
    await client.query('SELECT id FROM device_users ORDER BY id FOR UPDATE');
    const bindings = await previewEmployeeClockBindings(client, input.rows, input.overrides);
    const changed = bindings.filter((row) => row.changed);
    if (!changed.length) return { importId: null, changedCount: 0, bindings };
    const importId = randomUUID();
    await client.query(`INSERT INTO employee_clock_binding_imports (id,source_name,source_hash,rows,original_data)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`, [importId, input.sourceName, input.sourceHash,
      JSON.stringify({ source: input.rows, bindings }), JSON.stringify(await originalData(client, changed))]);
    await client.query("UPDATE device_users SET binding_status='historical' WHERE id=ANY($1::uuid[])", [changed.map((row) => row.clockRecordId)]);
    const registry = new PrismaEmployeeRegistrySession(client);
    for (const row of changed) {
      if (row.correctInitialBranch) {
        await client.query('UPDATE employees SET branch_id=$2,updated_at=NOW() WHERE id=$1', [row.employeeId, row.branchId]);
        await client.query(`INSERT INTO branch_assignments (id,employee_id,branch_id,effective_from) VALUES ($1,$2,$3,'1900-01-01')
          ON CONFLICT (employee_id,effective_from) DO UPDATE SET branch_id=EXCLUDED.branch_id`, [randomUUID(), row.employeeId, row.branchId]);
      }
      if (row.previousEmployeeId !== row.employeeId && row.previousEmployeeStatus === 'pending') {
        await registry.archiveAndMerge(row.previousEmployeeId, row.employeeId);
        await registry.finishMerge(row.previousEmployeeId, row.employeeId);
      } else {
        await client.query('UPDATE device_users SET employee_id=$2 WHERE id=$1', [row.clockRecordId, row.employeeId]);
      }
    }
    for (const row of changed) await registry.assignClock(row.employeeId, row.clockRecordId, row.previousClockId ?? undefined, 'assignment');
    const verified = await previewEmployeeClockBindings(client, input.rows, input.overrides);
    if (verified.some((row) => row.changed)) throw new Error('Los vínculos guardados no coinciden con el archivo.');
    return { importId, changedCount: changed.length, bindings: verified };
  });
}
