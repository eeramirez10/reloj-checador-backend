import { deepStrictEqual } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { databaseUrl, restoreArchive, withTemporaryDatabase } from './database-tools.js';

type RecordData = Record<string, unknown>;
const path = process.argv[2];
if (!path) throw new Error('Indica el manifiesto del respaldo previo a la refactorización.');
const manifest = JSON.parse(await readFile(path, 'utf8')) as {
  archive: string; verifiedRestore: boolean; tables: Record<string, { rows: number }>;
};
if (!manifest.verifiedRestore) throw new Error('El respaldo debe tener una restauración verificada.');

function identity(table: string, row: RecordData): string {
  if (table === 'device_user_photos') return `${row.device_id}:${row.device_user_id}`;
  if (table === 'auth_account_branches') return `${row.account_id}:${row.branch_id}`;
  if (table === 'auth_sessions') return String(row.token_hash);
  if (table === 'employee_leave_profiles') return String(row.employee_id);
  return String(row.id);
}

function protectedRecord(table: string, row: RecordData): RecordData {
  const fields: Record<string, string[]> = {
    attendance_evaluations: ['id', 'subject_id', 'employee_id', 'device_user_id', 'date'],
    attendance_incidents: ['id', 'evaluation_id', 'subject_id', 'kind'],
    attendance_deductions: ['id', 'subject_id', 'trigger_incident_id', 'salary_days', 'created_at'],
  };
  const keys = table === 'sync_runs' && row.status === 'running' ? ['id', 'device_id', 'sync_type', 'started_at'] : fields[table];
  return keys ? Object.fromEntries(keys.map((key) => [key, row[key]])) : row;
}

await withTemporaryDatabase('verify_refactor', async (url) => {
  await restoreArchive(url, manifest.archive);
  const original = new pg.Pool({ connectionString: url });
  const current = new pg.Pool({ connectionString: databaseUrl });
  const report: Record<string, { preserved: number; current: number }> = {};
  try {
    for (const table of Object.keys(manifest.tables)) {
      if (!/^[a-z_]+$/.test(table)) throw new Error('Nombre de tabla inválido en el manifiesto.');
      const before = (await original.query<{ record: RecordData }>(`SELECT to_jsonb(t) AS record FROM public."${table}" t`)).rows;
      const after = (await current.query<{ record: RecordData }>(`SELECT to_jsonb(t) AS record FROM public."${table}" t`)).rows;
      const byId = new Map(after.map(({ record }) => [identity(table, record), record]));
      for (const { record } of before) {
        const found = byId.get(identity(table, record));
        if (!found) throw new Error(`Falta un registro original en ${table}: ${identity(table, record)}.`);
        const expected = protectedRecord(table, record);
        const actual = Object.fromEntries(Object.keys(expected).map((key) => [key, found[key]]));
        deepStrictEqual(actual, expected, `Cambió información protegida en ${table}: ${identity(table, record)}.`);
      }
      report[table] = { preserved: before.length, current: after.length };
    }
    const integrity = (await current.query(`SELECT
      (SELECT COUNT(*)::int FROM device_users WHERE employee_id IS NULL) AS orphan_clock_records,
      (SELECT COUNT(*)::int FROM (SELECT employee_id FROM device_users WHERE binding_status='active' GROUP BY employee_id HAVING COUNT(*)>1) duplicates) AS duplicate_assigned_clocks,
      (SELECT COUNT(*)::int FROM attendance_logs a WHERE NOT EXISTS (SELECT 1 FROM device_users u WHERE u.device_id=a.device_id AND u.device_user_id=a.user_id)) AS orphan_attendance`)).rows[0];
    if (Object.values(integrity).some((value) => value !== 0)) throw new Error('Se encontraron relaciones incompletas.');
    const result = { verified: true, backup: manifest.archive, checkedAt: new Date().toISOString(), tables: report, integrity };
    await writeFile(path.replace(/\.json$/, '-verification.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await Promise.all([original.end(), current.end()]);
  }
});
