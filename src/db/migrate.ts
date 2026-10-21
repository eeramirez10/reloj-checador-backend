import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from './database.js';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function runMigrations(database: Database, through?: string): Promise<void> {
  const files = (await readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql') && (!through || file <= through)).sort();
  for (const file of files) {
    await database.query(await readFile(join(migrationsDirectory, file), 'utf8'));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { env } = await import('../config/env.js');
  const database = new Database(env.DATABASE_URL);
  runMigrations(database)
    .then(() => console.log('Migraciones aplicadas.'))
    .finally(() => database.close());
}
