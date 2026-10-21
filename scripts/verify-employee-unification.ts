import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { env } from '../src/infrastructure/config/env.js';
import { Database } from '../src/infrastructure/database/database.js';

async function main() {
  if (!process.argv[2]) throw new Error('Indica la ruta al manifiesto del respaldo anterior a la unificación.');
  const manifest = JSON.parse(await readFile(process.argv[2], 'utf8')) as { archive: string; verifiedRestore: boolean };
  if (!manifest.verifiedRestore) throw new Error('El respaldo no tiene una restauración verificada.');
  const database = new Database(env.DATABASE_URL);
  const url = new URL(env.DATABASE_URL);
  const validationName = `verify_unification_${randomUUID().replaceAll('-', '')}`;
  const container = process.env.PG_CONTAINER;
  const options = ['--host', container ? '127.0.0.1' : url.hostname, '--port', container ? '5432' : url.port || '5432', '--username', decodeURIComponent(url.username), '--dbname', validationName, '--no-owner', '--no-acl', '--exit-on-error'];
  const processEnv = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
  let original: Database | undefined;
  let created = false;
  const report: Record<string, unknown> = {};
  try {
    await database.query(`CREATE DATABASE "${validationName}"`);
    created = true;
    if (container) execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD', container, 'pg_restore', ...options], { env: processEnv, input: await readFile(manifest.archive), timeout: 120_000 });
    else execFileSync('pg_restore', [...options, manifest.archive], { env: processEnv, timeout: 120_000 });
    const originalUrl = new URL(url);
    originalUrl.pathname = `/${validationName}`;
    original = new Database(originalUrl.toString());
    for (const table of ['branches', 'devices', 'employees', 'device_users', 'device_user_photos', 'attendance_logs', 'branch_assignments', 'schedule_assignments', 'branch_policies', 'work_schedules', 'attendance_incidents', 'attendance_deductions', 'attendance_evaluations', 'sync_runs']) {
      const oldRows = (await original.query<{ record: Record<string, unknown> }>(`SELECT to_jsonb(t) AS record FROM public.${table} t`)).rows.map((row) => row.record);
      if (table === 'device_user_photos') {
        const current = (await database.query<{ record: Record<string, unknown> }>(`SELECT to_jsonb(t) AS record FROM public.${table} t`)).rows.map((row) => row.record);
        for (const row of oldRows) if (!current.some((item) => isDeepStrictEqual(item, row))) throw new Error('Una foto original cambió o falta.');
        report[table] = { preserved: oldRows.length, bytesAndMetadataUnchanged: true };
        continue;
      }
      const current = (await database.query<{ record: Record<string, unknown> }>(`SELECT to_jsonb(t) AS record FROM public.${table} t WHERE id = ANY($1::uuid[])`, [oldRows.map((row) => row.id)])).rows.map((row) => row.record);
      const currentById = new Map(current.map((row) => [row.id, row]));
      for (const row of oldRows) {
        const value = currentById.get(row.id);
        if (!value) throw new Error(`Falta un registro original en ${table}: ${row.id}.`);
        if (table === 'employees') {
          delete value.identification_status;
          delete value.merged_into_id;
        }
        if (table === 'device_users') {
          const snapshot = (await database.query<{ record: Record<string, unknown> }>("SELECT record - 'binding_status' AS record FROM employee_unification_snapshots WHERE source_type='device_user' AND source_id=$1", [row.id])).rows[0]?.record;
          if (!isDeepStrictEqual(snapshot, row)) throw new Error(`El registro original de reloj no coincide: ${row.id}.`);
          continue;
        }
        if (table === 'attendance_evaluations') {
          if (value.subject_id !== row.subject_id || value.date !== row.date) throw new Error('Cambió la identidad o fecha de una jornada original.');
          continue;
        }
        if (table === 'sync_runs') {
          if (value.device_id !== row.device_id || value.started_at !== row.started_at) throw new Error('Cambió el origen de una sincronización original.');
          continue;
        }
        if (!isDeepStrictEqual(value, row)) throw new Error(`Cambió un registro protegido de ${table}: ${row.id}.`);
      }
      report[table] = { preserved: oldRows.length, verified: true };
    }
    const integrity = (await database.query(`SELECT
      (SELECT COUNT(*) FROM device_users WHERE employee_id IS NULL) AS orphan_clock_records,
      (SELECT COUNT(*) FROM (SELECT employee_id FROM device_users WHERE binding_status='active' GROUP BY employee_id HAVING COUNT(*)>1) duplicates) AS duplicate_assigned_clocks,
      (SELECT COUNT(*) FROM attendance_logs a WHERE NOT EXISTS (SELECT 1 FROM device_users u WHERE u.device_id=a.device_id AND u.device_user_id=a.user_id)) AS orphan_attendance`)).rows[0];
    if (Object.values(integrity).some((value) => Number(value) !== 0)) throw new Error('Se encontraron relaciones incompletas después de la unificación.');
    const result = { verified: true, backup: manifest.archive, tables: report, integrity, checkedAt: new Date().toISOString() };
    await writeFile(process.argv[2].replace(/\.json$/, '-verification.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await original?.close();
    if (created) await database.query(`DROP DATABASE "${validationName}"`);
    await database.close();
  }
}
void main();
