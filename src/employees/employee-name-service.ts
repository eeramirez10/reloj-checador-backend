import type { Database } from '../db/database.js';
import { splitEmployeeName } from './employee-name.js';

export class EmployeeNameService {
  constructor(private readonly database: Database) {}

  async populateMissing(refreshAutomatic = false): Promise<{ updated: number; unknown: number; methods: Record<string, number> }> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-name-prefill'))");
      const rows = (await client.query<{ id: string; name: string; original_name: string | null; name_split_method: string | null; employee_number: string | null; clock_names: string[] }>(
        `SELECT e.id, e.name, e.original_name, e.name_split_method, e.employee_number,
          COALESCE((SELECT array_agg(u.name ORDER BY (u.binding_status = 'active') DESC, u.synced_at DESC) FILTER (WHERE u.name IS NOT NULL)
            FROM device_users u WHERE u.employee_id = e.id), ARRAY[]::text[]) AS clock_names
         FROM employees e WHERE e.identification_status <> 'merged' AND ((e.first_name IS NULL AND e.last_name IS NULL)
           OR ($1::boolean AND e.name_split_method IN ('single_name','clock_reference','given_first','surname_first'))) FOR UPDATE OF e`, [refreshAutomatic])).rows;
      let updated = 0;
      let unknown = 0;
      const methods: Record<string, number> = {};
      for (const row of rows) {
        const fullName = refreshAutomatic && row.name_split_method !== 'manual_full_name' ? row.original_name ?? row.name : row.name;
        const parts = splitEmployeeName(fullName, Boolean(row.employee_number) && row.name_split_method !== 'manual_full_name', row.clock_names);
        if (!parts.firstName) { unknown += 1; continue; }
        await client.query(`UPDATE employees SET first_name = $2, last_name = $3, original_name = COALESCE(original_name, name),
          name = $4, name_split_method = $5, updated_at = NOW() WHERE id = $1`, [row.id, parts.firstName, parts.lastName ?? null,
          [parts.firstName, parts.lastName].filter(Boolean).join(' '), row.name_split_method === 'manual_full_name' ? 'manual' : parts.method]);
        updated += 1;
        methods[parts.method] = (methods[parts.method] ?? 0) + 1;
      }
      return { updated, unknown, methods };
    });
  }
}
