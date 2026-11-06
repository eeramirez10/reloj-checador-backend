import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/infrastructure/config/env.js';
import { Database } from '../src/infrastructure/database/database.js';
import { importEmployeeClockBindings, normalizeCardNumber, previewEmployeeClockBindings, type EmployeeCardRow } from '../src/infrastructure/imports/employee-clock-bindings.js';
import { createAttendanceEvaluation } from '../src/main.js';
import { PrismaOrganizationDatasource } from '../src/infrastructure/datasources/organization-datasource.js';

const args = process.argv.slice(2);
const path = args[0];
if (!path || path.startsWith('--')) throw new Error('Indica el archivo Excel. Usa --apply para guardar y --device-override numeros=UUID para seleccionar un reloj explícito.');
const overrides = new Map<string, string>();
for (let index = 1; index < args.length; index++) {
  if (args[index] === '--apply') continue;
  if (args[index] !== '--device-override') throw new Error(`Argumento desconocido: ${args[index]}.`);
  const match = args[++index]?.match(/^([\d,]+)=([\da-f-]{36})$/i);
  if (!match) throw new Error('Formato esperado: --device-override 1545,3077=UUID-del-reloj.');
  for (const number of match[1].split(',')) overrides.set(normalizeCardNumber(number), match[2]);
}
const source = resolve(path);
const rows = JSON.parse(execFileSync('python3', [fileURLToPath(new URL('./read-employee-cards.py', import.meta.url)), source], {
  encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
})) as EmployeeCardRow[];
const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex');
const database = new Database(env.DATABASE_URL);
try {
  if (!args.includes('--apply')) {
    const bindings = await database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return previewEmployeeClockBindings(client, rows, overrides);
    });
    console.log(JSON.stringify({ source: basename(source), sourceHash, total: bindings.length,
      changedCount: bindings.filter((row) => row.changed).length, bindings }, null, 2));
  } else {
    const result = await importEmployeeClockBindings(database, { sourceName: basename(source), sourceHash, rows, overrides });
    const recalculated = await createAttendanceEvaluation(database, new PrismaOrganizationDatasource(database)).recalculate();
    console.log(JSON.stringify({ source: basename(source), total: result.bindings.length, ...result, recalculated }, null, 2));
  }
} finally {
  await database.close();
}
