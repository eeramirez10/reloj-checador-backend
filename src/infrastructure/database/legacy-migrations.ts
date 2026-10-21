import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './database.js';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

export async function runMigrations(database: Database, through?: string): Promise<void> {
  const location = (await database.query<{ database: string; schema: string }>('SELECT current_database() AS database, current_schema() AS schema')).rows[0];
  if (!location.database.startsWith('test_') && !location.schema.startsWith('test_')) {
    throw new Error('Las migraciones históricas solo se ejecutan en bases o esquemas de pruebas con prefijo test_. Usa Prisma Migrate para la aplicación.');
  }
  await database.query('CREATE TABLE IF NOT EXISTS _legacy_migrations (name TEXT PRIMARY KEY)');
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql') && (!through || file <= through)).sort();
  for (const file of files) {
    if ((await database.query('SELECT name FROM _legacy_migrations WHERE name = $1', [file])).rows.length) continue;
    await database.executeScript(await readFile(join(migrationsDirectory, file), 'utf8'));
    await database.query('INSERT INTO _legacy_migrations (name) VALUES ($1)', [file]);
  }
}
