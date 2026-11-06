import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { connectionString } from '../src/infrastructure/database/connection-string.js';

export const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Configura DATABASE_URL.');

export async function withTemporaryDatabase<T>(prefix: string, operation: (url: string) => Promise<T>, adminUrl = process.env.LOCAL_DATABASE_URL || databaseUrl!): Promise<T> {
  if (!/^[a-z_]+$/.test(prefix)) throw new Error('Prefijo de base temporal inválido.');
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: connectionString(adminUrl) });
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    url.searchParams.delete('options');
    url.searchParams.delete('schema');
    return await operation(url.toString());
  } finally {
    try { if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); }
    finally { await admin.end(); }
  }
}

export async function restoreArchive(connection: string, archive: string): Promise<void> {
  runPostgresTool('pg_restore', connection, ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction'], await readFile(archive));
}

export function runPostgresTool(tool: 'pg_dump' | 'pg_restore', connection: string, args: string[], input?: Buffer): Buffer {
  const url = new URL(connectionString(connection));
  const local = ['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname);
  const container = local ? process.env.PG_CONTAINER : undefined;
  const remote = !local;
  const variables = {
    PGHOST: container ? '127.0.0.1' : url.hostname, PGPORT: container ? '5432' : url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get('sslmode') ?? (remote ? 'verify-full' : 'prefer'),
    PGSSLROOTCERT: remote ? '/etc/ssl/certs/ca-certificates.crt' : '', PGCONNECT_TIMEOUT: '25',
    PGOPTIONS: url.searchParams.get('options') ?? '',
  };
  const env = { ...process.env, ...variables };
  const options = { env, input, timeout: 300_000, maxBuffer: 256 * 1024 * 1024 };
  const environmentArgs = Object.keys(variables).flatMap(name => ['-e',name]);
  const toolArgs = ['--dbname',variables.PGDATABASE,...args];
  if (container) return execFileSync('docker', ['exec','-i',...environmentArgs,container,tool,...toolArgs], options);
  if (remote) return execFileSync('docker', ['run','--rm','-i',...environmentArgs,process.env.PG_CLIENT_IMAGE ?? 'postgres:18-alpine',tool,...toolArgs], options);
  return execFileSync(tool, toolArgs, options);
}

export function deployMigrations(url: string): void {
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit', timeout: 120_000,
  });
}
