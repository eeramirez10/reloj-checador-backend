import 'dotenv/config';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { databaseForEnvironment } from '../src/infrastructure/config/database-environment.js';
import { Database } from '../src/infrastructure/database/database.js';

const { values } = parseArgs({ options: { 'prepare-only': { type: 'boolean', default: false } } });
const path = resolve('.env');
const contents = await readFile(path, 'utf8');
const configuration = parse(contents);
const production = configuration.PRODUCTION_DATABASE_URL || configuration.DATABASE_URL;
if (!production) throw new Error('Falta la referencia a la base de producción.');
const changes: Record<string,string> = {
  APP_ENV: 'development', PRODUCTION_DATABASE_URL: production, SYNC_ENABLED: 'false', TWILIO_WHATSAPP_ENABLED: 'false', EMAIL_ENABLED: 'false',
  AUTH_COOKIE_SECURE: 'false', AUTH_ALLOWED_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3005',
};

if (!values['prepare-only']) {
  const development = configuration.DEVELOPMENT_DATABASE_URL;
  if (!development) throw new Error('Crea una rama development en Neon y agrega su conexión directa como DEVELOPMENT_DATABASE_URL en .env.');
  const target = databaseForEnvironment({ APP_ENV: 'development', DATABASE_URL: development, PRODUCTION_DATABASE_URL: production });
  const database = new Database(target);
  try {
    await database.transaction(async client => {
      await client.query('SET TRANSACTION READ ONLY');
      const ready = (await client.query("SELECT to_regclass('public.employees') IS NOT NULL AND to_regclass('public.auth_accounts') IS NOT NULL AS ready")).rows[0].ready;
      if (!ready) throw new Error('La rama de desarrollo debe ser una copia de la rama actual de producción, con sus tablas y datos.');
    });
  } finally { await database.close(); }
  changes.DATABASE_URL = target;
}

const backupDirectory = resolve('backups');
await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
const backup = resolve(backupDirectory, `development-config-${new Date().toISOString().replace(/[:.]/g,'-')}.env`);
await writeFile(backup, contents, { mode: 0o600, flag: 'wx' });
let updated = contents;
const newline = contents.includes('\r\n') ? '\r\n' : '\n';
for (const [name,value] of Object.entries(changes)) {
  const pattern = new RegExp(`^[\\t ]*${name}[\\t ]*=.*$`, 'gm');
  const matches = updated.match(pattern) ?? [];
  if (matches.length > 1) throw new Error(`Existe más de una definición de ${name}. Conserva una sola antes de configurar desarrollo.`);
  const entry = `${name}=${JSON.stringify(value)}`;
  updated = matches.length ? updated.replace(pattern, () => entry) : `${updated}${updated.endsWith('\n') ? '' : newline}${entry}${newline}`;
}
const temporary = `${path}.${randomUUID()}.tmp`;
await writeFile(temporary, updated, { mode: 0o600, flag: 'wx' });
await rename(temporary, path);
console.log(JSON.stringify({ prepared: true, developmentDatabaseActivated: !values['prepare-only'], automaticSync: false, whatsAppEnabled: false, emailEnabled: false,
  productionStartupBlocked: true, previousConfiguration: backup, nextStep: values['prepare-only'] ? 'Agregar DEVELOPMENT_DATABASE_URL y ejecutar npm run dev:configure.' : 'Ejecutar npm run migrate y npm run dev.' }, null, 2));
