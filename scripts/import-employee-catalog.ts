import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../src/config/env.js';
import { Database } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrate.js';
import { parseEmployeeCatalog } from '../src/employees/employee-catalog.js';
import { EmployeeRepository } from '../src/employees/employee-repository.js';
import { EmployeeNameService } from '../src/employees/employee-name-service.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(process.argv[2] ?? `${scriptDirectory}/../docs/CATALOGO-EMPLEADOS.pdf`);

function extractPdfText(path: string): string {
  try {
    return execFileSync('pdftotext', ['-tsv', path, '-'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new Error('No se encontró pdftotext. Instala Poppler para importar el catálogo PDF.');
    }
    throw error;
  }
}

const employees = parseEmployeeCatalog(extractPdfText(sourcePath));
const database = new Database(env.DATABASE_URL);

try {
  await runMigrations(database);
  await database.transaction(async (client) => {
    const repository = new EmployeeRepository(client);
    for (const employee of employees) await repository.upsert(employee);
  });
  await new EmployeeNameService(database).populateMissing();

  const summary = await database.query<{ employee_count: string; linked_user_count: string }>(
    `SELECT
       (SELECT COUNT(*) FROM employees) AS employee_count,
        (SELECT COUNT(*) FROM device_users WHERE employee_id IS NOT NULL) AS linked_user_count`
  );
  console.log(`Catálogo importado: ${summary.rows[0].employee_count} empleados; ${summary.rows[0].linked_user_count} registros de reloj asociados.`);
} finally {
  await database.close();
}
