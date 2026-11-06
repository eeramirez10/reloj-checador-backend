import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../src/infrastructure/config/env.js';
import { Database } from '../src/infrastructure/database/database.js';
import { databaseInventory as inventory } from './database-inventory.js';
import { restoreArchive, runPostgresTool, withTemporaryDatabase } from './database-tools.js';

async function main() {
  const database = new Database(env.DATABASE_URL);
  const directory = resolve('backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const label = process.env.BACKUP_LABEL ?? 'employee-unification';
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('La etiqueta del respaldo debe contener solo letras, números y guiones.');
  const prefix = `before-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const archive = resolve(directory, `${prefix}.dump`);
  const manifest = resolve(directory, `${prefix}.json`);
  try {
    const original = await database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const snapshot = (await client.query<{ id: string }>('SELECT pg_export_snapshot() AS id')).rows[0].id;
      const data = await inventory(client);
      const contents = runPostgresTool('pg_dump', env.DATABASE_URL, ['--format=custom','--no-owner','--no-acl','--snapshot',snapshot]);
      await writeFile(archive, contents, { mode: 0o600 });
      return data;
    }, { timeoutMs: 180_000 });
    await withTemporaryDatabase('restore_check', async url => {
      await restoreArchive(url, archive);
      const restored = new Database(url);
      try {
        const verified = await inventory(restored);
        if (JSON.stringify(original) !== JSON.stringify(verified)) throw new Error('El respaldo restaurado no coincide con los datos originales.');
      } finally { await restored.close(); }
    }, env.DATABASE_URL);
    await writeFile(manifest, JSON.stringify({ archive, verifiedRestore: true, createdAt: new Date().toISOString(), tables: original }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ archive, manifest, verifiedRestore: true, tables: original }, null, 2));
  } finally {
    await database.close();
  }
}
void main();
