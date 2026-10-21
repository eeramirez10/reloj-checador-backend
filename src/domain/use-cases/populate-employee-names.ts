import type { EmployeeNameRepository } from '../repositories/employee-name-repository.js';
import { splitEmployeeName } from '../entities/employee-name.js';

export class EmployeeNameService {
  constructor(private readonly repository: EmployeeNameRepository) {}

  async populateMissing(refreshAutomatic = false): Promise<{ updated: number; unknown: number; methods: Record<string, number> }> {
    return this.repository.transaction(async (session) => {
      const rows = await session.candidates(refreshAutomatic);
      let updated = 0;
      let unknown = 0;
      const methods: Record<string, number> = {};
      for (const row of rows) {
        const fullName = refreshAutomatic && row.splitMethod !== 'manual_full_name' ? row.originalName ?? row.name : row.name;
        const parts = splitEmployeeName(fullName, Boolean(row.employeeNumber) && row.splitMethod !== 'manual_full_name', row.clockNames);
        if (!parts.firstName) { unknown += 1; continue; }
        await session.save(row.id, parts.firstName, parts.lastName, row.splitMethod === 'manual_full_name' ? 'manual' : parts.method);
        updated += 1;
        methods[parts.method] = (methods[parts.method] ?? 0) + 1;
      }
      return { updated, unknown, methods };
    });
  }
}
