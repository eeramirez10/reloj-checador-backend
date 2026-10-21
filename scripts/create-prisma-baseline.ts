import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

try {
  const sql = execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'diff', '--from-empty', '--to-config-datasource', '--script'], { encoding: 'utf8' });
  const constraints = await pool.query<{ table_name: string; name: string; definition: string }>(`
    SELECT t.relname AS table_name, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'c' AND n.nspname = 'public' ORDER BY t.relname, c.conname`);
  const checks = constraints.rows.map((row) =>
    `ALTER TABLE ${quoteIdentifier(row.table_name)} ADD CONSTRAINT ${quoteIdentifier(row.name)} ${row.definition};`).join('\n');
  const arrays = await pool.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'ARRAY' AND is_nullable = 'NO' ORDER BY table_name, column_name`);
  const notNullArrays = arrays.rows.map((row) =>
    `ALTER TABLE ${quoteIdentifier(row.table_name)} ALTER COLUMN ${quoteIdentifier(row.column_name)} SET NOT NULL;`).join('\n');
  const path = new URL('../prisma/migrations/00000000000000_baseline/migration.sql', import.meta.url);
  await writeFile(path, `${sql}\n-- Restricciones de PostgreSQL que Prisma no representa en el modelo.\n${checks}\n${notNullArrays}\n`, { flag: 'wx' });
  console.log(`Baseline creada: ${fileURLToPath(path)} (${constraints.rowCount} restricciones CHECK).`);
} finally {
  await pool.end();
}
