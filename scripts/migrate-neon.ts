import 'dotenv/config';
import { deepStrictEqual } from 'node:assert';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { Database } from '../src/infrastructure/database/database.js';
import { connectionString } from '../src/infrastructure/database/connection-string.js';
import { databaseInventory } from './database-inventory.js';
import { restoreArchive } from './database-tools.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'verify-only': { type: 'boolean', default: false } } });
const manifestPath = positionals[0];
if (!manifestPath || !process.env.NEON_DATABASE_URL) throw new Error('Indica el manifiesto y configura NEON_DATABASE_URL.');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { archive: string; verifiedRestore: boolean; tables: object };
if (!manifest.verifiedRestore) throw new Error('El respaldo debe tener una restauración verificada.');
const targetUrl = new URL(connectionString(process.env.NEON_DATABASE_URL));
if (!targetUrl.hostname.endsWith('.neon.tech')) throw new Error('El destino no es una conexión directa de Neon.');
const sourceUrl = new URL(process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL!);
if (sourceUrl.hostname === targetUrl.hostname && sourceUrl.pathname === targetUrl.pathname) throw new Error('El origen y el destino deben ser distintos.');
const source = new Database(sourceUrl.toString());
const target = new Database(targetUrl.toString());

async function schema(database: Database) {
  return {
    columns: (await database.query(`SELECT table_name,column_name,udt_name,is_nullable,column_default FROM information_schema.columns
      WHERE table_schema='public' ORDER BY table_name,column_name`)).rows,
    constraints: (await database.query(`SELECT t.relname AS table_name,c.conname,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND c.contype IN ('c','f') ORDER BY t.relname,c.conname`)).rows,
    indexes: (await database.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows,
  };
}

try {
  const original = await source.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return databaseInventory(client);
  });
  deepStrictEqual(original, manifest.tables, 'El origen cambió después del respaldo. Pausa el backend y crea una copia definitiva.');
  if (!values['verify-only']) {
    const tables = (await target.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows;
    if (tables.length) throw new Error('Neon no está vacío. No se sobrescribirá ningún dato.');
    await restoreArchive(targetUrl.toString(), manifest.archive);
  }
  const restored = await target.transaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return databaseInventory(client);
  });
  deepStrictEqual(restored, original, 'Los datos de Neon no coinciden exactamente con el respaldo.');
  deepStrictEqual(await schema(target), await schema(source), 'El esquema, las restricciones o los índices no coinciden.');
  const integrity = (await target.query(`SELECT
    (SELECT COUNT(*)::int FROM device_users WHERE employee_id IS NULL) AS orphan_clock_records,
    (SELECT COUNT(*)::int FROM (SELECT employee_id FROM device_users WHERE binding_status='active' GROUP BY employee_id HAVING COUNT(*)>1) duplicates) AS duplicate_assigned_clocks,
    (SELECT COUNT(*)::int FROM attendance_logs a WHERE NOT EXISTS (SELECT 1 FROM device_users u WHERE u.device_id=a.device_id AND u.device_user_id=a.user_id)) AS orphan_attendance`)).rows[0];
  if (Object.values(integrity).some(value => value !== 0)) throw new Error('La copia contiene relaciones inconsistentes.');
  const report = { verified: true, checkedAt: new Date().toISOString(), target: { host: targetUrl.hostname, database: targetUrl.pathname.slice(1) }, tables: restored, integrity };
  const reportPath = manifestPath.replace(/\.json$/, '-neon-verification.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
} finally { await source.close(); await target.close(); }
