import { deepStrictEqual } from 'node:assert';
import pg from 'pg';
import { databaseUrl, deployMigrations, withTemporaryDatabase } from './database-tools.js';
import { readFile } from 'node:fs/promises';

const baselineOnly = process.argv.includes('--baseline-only');

async function schemaInventory(url: string) {
  const pool = new pg.Pool({ connectionString: url });
  try {
    const columns = (await pool.query(`SELECT table_name, column_name, udt_name, is_nullable,
      CASE WHEN column_default = 'CURRENT_TIMESTAMP' THEN 'now()' ELSE column_default END AS column_default
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
      ORDER BY table_name, column_name`)).rows;
    const constraints = (await pool.query(`SELECT t.relname AS table_name, c.conname AS name, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.contype IN ('c','f') AND n.nspname = 'public' ORDER BY t.relname, c.conname`)).rows;
    const indexes = (await pool.query(`SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename, indexname`)).rows;
    return { columns, constraints, indexes };
  } finally { await pool.end(); }
}

await withTemporaryDatabase('verify_prisma', async (url) => {
  if (baselineOnly) {
    const pool = new pg.Pool({ connectionString: url });
    try { await pool.query(await readFile(new URL('../prisma/migrations/00000000000000_baseline/migration.sql', import.meta.url), 'utf8')); }
    finally { await pool.end(); }
  } else deployMigrations(url);
  deepStrictEqual(await schemaInventory(url), await schemaInventory(databaseUrl!), 'La baseline debe reproducir columnas, restricciones e índices existentes.');
  if (!baselineOnly) deployMigrations(url);
  console.log(baselineOnly ? 'Baseline histórica verificada: columnas, restricciones e índices equivalentes.'
    : 'Baseline verificada: esquema equivalente, restricciones e índices conservados y despliegue idempotente.');
});
