import type { Database, Queryable } from '../database/database.js';
import type { EmployeeNameDatasource } from '../../domain/datasources/employee-name-datasource.js';
import type { EmployeeNameCandidate, EmployeeNameSession } from '../../domain/repositories/employee-name-repository.js';

class PrismaEmployeeNameSession implements EmployeeNameSession {
  constructor(private readonly database: Queryable) {}

  async candidates(refreshAutomatic: boolean): Promise<EmployeeNameCandidate[]> {
    return (await this.database.query<EmployeeNameCandidate>(`SELECT e.id, e.name, e.original_name AS "originalName",
      e.name_split_method AS "splitMethod", e.employee_number AS "employeeNumber",
      COALESCE((SELECT array_agg(u.name ORDER BY (u.binding_status = 'active') DESC, u.synced_at DESC) FILTER (WHERE u.name IS NOT NULL)
        FROM device_users u WHERE u.employee_id = e.id), ARRAY[]::text[]) AS "clockNames"
      FROM employees e WHERE e.discarded_at IS NULL AND e.identification_status <> 'merged' AND ((e.first_name IS NULL AND e.last_name IS NULL)
        OR ($1::boolean AND e.name_split_method IN ('single_name','clock_reference','given_first','surname_first'))) FOR UPDATE OF e`, [refreshAutomatic])).rows;
  }

  async save(id: string, firstName: string, lastName: string | undefined, method: string): Promise<void> {
    await this.database.query(`UPDATE employees SET first_name = $2, last_name = $3, original_name = COALESCE(original_name, name),
      name = $4, name_split_method = $5, updated_at = NOW() WHERE id = $1`,
    [id, firstName, lastName ?? null, [firstName, lastName].filter(Boolean).join(' '), method]);
  }
}

export class PrismaEmployeeNameDatasource implements EmployeeNameDatasource {
  constructor(private readonly database: Database) {}

  transaction<T>(operation: (session: EmployeeNameSession) => Promise<T>): Promise<T> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('attendance-evaluation'))::text");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-name-prefill'))::text");
      return operation(new PrismaEmployeeNameSession(client));
    });
  }
}
