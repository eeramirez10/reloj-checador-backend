import { deepStrictEqual } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { databaseUrl, restoreArchive, withTemporaryDatabase } from './database-tools.js';
import type { EmployeeClockBinding } from '../src/infrastructure/imports/employee-clock-bindings.js';

type RecordData = Record<string, unknown>;
const [path, importId] = process.argv.slice(2);
if (!path || !importId) throw new Error('Indica el manifiesto del respaldo y el UUID de la conciliación.');
const manifest = JSON.parse(await readFile(path, 'utf8')) as { archive: string; verifiedRestore: boolean; tables: Record<string, unknown> };
if (!manifest.verifiedRestore) throw new Error('El respaldo debe tener una restauración verificada.');

const identity = (table: string, row: RecordData) => table === 'device_user_photos' ? `${row.device_id}:${row.device_user_id}` : String(row.id);
const stableFields: Record<string, string[]> = {
  attendance_evaluations: ['id', 'subject_id', 'employee_id', 'device_user_id', 'date'],
  attendance_incidents: ['id', 'evaluation_id', 'subject_id', 'kind'],
  attendance_deductions: ['id', 'subject_id', 'trigger_incident_id', 'salary_days', 'created_at'],
};

await withTemporaryDatabase('verify_card_bindings', async (url) => {
  await restoreArchive(url, manifest.archive);
  const original = new pg.Pool({ connectionString: url });
  const current = new pg.Pool({ connectionString: databaseUrl });
  try {
    const audit = (await current.query<{ rows: { bindings: EmployeeClockBinding[] } }>('SELECT rows FROM employee_clock_binding_imports WHERE id=$1', [importId])).rows[0];
    if (!audit) throw new Error('Conciliación no encontrada.');
    const changed = audit.rows.bindings.filter((row) => row.changed);
    const expectedEmployees = new Map((await original.query<{ record: RecordData }>('SELECT to_jsonb(e) AS record FROM employees e')).rows.map(({ record }) => [String(record.id), record]));
    const updatedEmployees = new Set<string>();
    for (const row of changed) {
      const target = expectedEmployees.get(row.employeeId)!;
      if (row.correctInitialBranch) { target.branch_id = row.branchId; updatedEmployees.add(row.employeeId); }
      if (row.previousEmployeeId !== row.employeeId && row.previousEmployeeStatus === 'pending') {
        const source = expectedEmployees.get(row.previousEmployeeId)!;
        for (const field of ['rfc', 'imss', 'branch_id', 'position']) target[field] ??= source[field];
        source.identification_status = 'merged'; source.merged_into_id = target.id;
        updatedEmployees.add(row.previousEmployeeId); updatedEmployees.add(row.employeeId);
      }
    }
    const report: Record<string, { preserved: number; current: number }> = {};
    for (const table of Object.keys(manifest.tables)) {
      if (table === '_prisma_migrations') continue;
      if (!/^[a-z_]+$/.test(table)) throw new Error('Nombre de tabla inválido.');
      const before = (await original.query<{ record: RecordData }>(`SELECT to_jsonb(t) AS record FROM public."${table}" t`)).rows;
      const after = (await current.query<{ record: RecordData }>(`SELECT to_jsonb(t) AS record FROM public."${table}" t`)).rows;
      const byId = new Map(after.map(({ record }) => [identity(table, record), record]));
      for (const { record } of before) {
        const found = byId.get(identity(table, record));
        if (!found) throw new Error(`Falta un registro original en ${table}: ${identity(table, record)}.`);
        const expected = { ...(table === 'employees' ? expectedEmployees.get(String(record.id))! : record) };
        if (table === 'employees' && updatedEmployees.has(String(record.id))) delete expected.updated_at;
        if (table === 'device_users') {
          const binding = changed.find((row) => row.clockRecordId === record.id);
          if (binding) { expected.employee_id = binding.employeeId; expected.binding_status = 'active'; }
        }
        if (table === 'branch_assignments') {
          const binding = changed.find((row) => row.correctInitialBranch && row.employeeId === record.employee_id);
          if (binding) expected.branch_id = binding.branchId;
        }
        const fields = table === 'sync_runs' && record.status === 'running' ? ['id', 'device_id', 'sync_type', 'started_at'] : stableFields[table];
        const protectedExpected = fields ? Object.fromEntries(fields.map((field) => [field, expected[field]])) : expected;
        const actual = Object.fromEntries(Object.keys(protectedExpected).map((field) => [field, found[field]]));
        deepStrictEqual(actual, protectedExpected, `Cambió información no autorizada en ${table}: ${identity(table, record)}.`);
      }
      report[table] = { preserved: before.length, current: after.length };
    }
    for (const binding of audit.rows.bindings) {
      const found = (await current.query(`SELECT u.employee_id,u.binding_status,e.branch_id,e.identification_status
        FROM device_users u JOIN employees e ON e.id=u.employee_id WHERE u.id=$1 AND u.device_id=$2`, [binding.clockRecordId, binding.deviceId])).rows[0];
      deepStrictEqual(found, { employee_id: binding.employeeId, binding_status: 'active', branch_id: binding.branchId, identification_status: 'confirmed' });
    }
    const integrity = (await current.query(`SELECT
      (SELECT count(*)::int FROM device_users WHERE employee_id IS NULL) AS orphan_clock_records,
      (SELECT count(*)::int FROM (SELECT employee_id FROM device_users WHERE binding_status='active' GROUP BY employee_id HAVING count(*)>1) duplicates) AS duplicate_assigned_clocks,
      (SELECT count(*)::int FROM attendance_logs a WHERE NOT EXISTS (SELECT 1 FROM device_users u WHERE u.device_id=a.device_id AND u.device_user_id=a.user_id)) AS orphan_attendance`)).rows[0];
    if (Object.values(integrity).some((count) => count !== 0)) throw new Error('Existen relaciones incompletas.');
    const result = { verified: true, importId, checkedAt: new Date().toISOString(), checkedBindings: audit.rows.bindings.length, correctedBindings: changed.length, tables: report, integrity };
    await writeFile(path.replace(/\.json$/, '-card-bindings-verification.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  } finally { await Promise.all([original.end(), current.end()]); }
});
