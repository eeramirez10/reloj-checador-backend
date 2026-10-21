import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../src/infrastructure/config/env.js';
import { Database, type Queryable } from '../src/infrastructure/database/database.js';

async function inventory(database: Queryable) {
  const tables = (await database.query<{ name: string; identifier: string }>(
    `SELECT tablename AS name, format('%I.%I', schemaname, tablename) AS identifier FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows;
  const result: Record<string, { rows: number; checksum: string }> = {};
  for (const table of tables) result[table.name] = (await database.query<{ rows: number; checksum: string }>(
    `SELECT COUNT(*)::int AS rows, md5(COALESCE(string_agg(to_jsonb(t)::text, E'\n' ORDER BY to_jsonb(t)::text), '')) AS checksum FROM ${table.identifier} t`)).rows[0];
  return result;
}

async function main() {
  const url = new URL(env.DATABASE_URL);
  const database = new Database(env.DATABASE_URL);
  const directory = resolve('backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const label = process.env.BACKUP_LABEL ?? 'employee-unification';
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('La etiqueta del respaldo debe contener solo letras, números y guiones.');
  const prefix = `before-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const archive = resolve(directory, `${prefix}.dump`);
  const manifest = resolve(directory, `${prefix}.json`);
  const validationName = `restore_check_${randomUUID().replaceAll('-', '')}`;
  const container = process.env.PG_CONTAINER;
  const options = ['--host', container ? '127.0.0.1' : url.hostname, '--port', container ? '5432' : url.port || '5432', '--username', decodeURIComponent(url.username)];
  const processEnv = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
  let validationCreated = false;
  let restored: Database | undefined;
  try {
    const original = await database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const snapshot = (await client.query<{ id: string }>('SELECT pg_export_snapshot() AS id')).rows[0].id;
      const data = await inventory(client);
      const dumpOptions = [...options, '--dbname', decodeURIComponent(url.pathname.slice(1)), '--format=custom', '--no-owner', '--no-acl', '--snapshot', snapshot];
      if (container) {
        const contents = execFileSync('docker', ['exec', '-e', 'PGPASSWORD', container, 'pg_dump', ...dumpOptions], { env: processEnv, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
        await writeFile(archive, contents, { mode: 0o600 });
      } else execFileSync('pg_dump', [...dumpOptions, '--file', archive], { env: processEnv, timeout: 120_000 });
      return data;
    });
    await database.query(`CREATE DATABASE "${validationName}"`);
    validationCreated = true;
    const restoreOptions = [...options, '--dbname', validationName, '--no-owner', '--no-acl', '--exit-on-error'];
    if (container) execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD', container, 'pg_restore', ...restoreOptions], { env: processEnv, input: await readFile(archive), timeout: 120_000 });
    else execFileSync('pg_restore', [...restoreOptions, archive], { env: processEnv, timeout: 120_000 });
    const restoredUrl = new URL(url);
    restoredUrl.pathname = `/${validationName}`;
    restored = new Database(restoredUrl.toString());
    const verified = await inventory(restored);
    if (JSON.stringify(original) !== JSON.stringify(verified)) throw new Error('El respaldo restaurado no coincide con los datos originales.');
    await writeFile(manifest, JSON.stringify({ archive, verifiedRestore: true, createdAt: new Date().toISOString(), tables: original }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ archive, manifest, verifiedRestore: true, tables: original }, null, 2));
  } finally {
    await restored?.close();
    if (validationCreated) await database.query(`DROP DATABASE "${validationName}"`);
    await database.close();
  }
}
void main();
