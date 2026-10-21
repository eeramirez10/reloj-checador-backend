import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

export const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Configura DATABASE_URL.');

export async function withTemporaryDatabase<T>(prefix: string, operation: (url: string) => Promise<T>): Promise<T> {
  if (!/^[a-z_]+$/.test(prefix)) throw new Error('Prefijo de base temporal inválido.');
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(databaseUrl!);
    url.pathname = `/${name}`;
    url.search = '';
    return await operation(url.toString());
  } finally {
    try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally { await admin.end(); }
  }
}

export async function restoreArchive(connection: string, archive: string): Promise<void> {
  const url = new URL(connection);
  const container = process.env.PG_CONTAINER;
  const options = ['--host', container ? '127.0.0.1' : url.hostname, '--port', container ? '5432' : url.port || '5432',
    '--username', decodeURIComponent(url.username), '--dbname', decodeURIComponent(url.pathname.slice(1)), '--no-owner', '--no-acl', '--exit-on-error'];
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(url.password) };
  if (container) {
    execFileSync('docker', ['exec', '-i', '-e', 'PGPASSWORD', container, 'pg_restore', ...options], {
      env, input: await readFile(archive), timeout: 120_000,
    });
  } else execFileSync('pg_restore', [...options, archive], { env, timeout: 120_000 });
}

export function deployMigrations(url: string): void {
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit', timeout: 120_000,
  });
}
