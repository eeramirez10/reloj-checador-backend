import type { BranchAttendanceDatasource } from '../../domain/datasources/branch-attendance-datasource.js';
import type { BranchAttendanceFilters, BranchAttendanceQuery } from '../../domain/entities/branch-attendance.js';
import type { BranchAttendanceSnapshot } from '../../domain/repositories/branch-attendance-repository.js';
import { NotFoundError } from '../../domain/errors/not-found-error.js';
import type { Database } from '../database/database.js';
import { employeeSelectColumns, mapEmployeeRow, type EmployeeRow } from './employee-datasource.js';
import { loadEmployeeAttendanceHistories } from './employee-attendance-datasource.js';

export class PrismaBranchAttendanceDatasource implements BranchAttendanceDatasource {
  constructor(private readonly database: Pick<Database, 'transaction'>) {}

  snapshot(query: BranchAttendanceQuery): Promise<BranchAttendanceSnapshot> {
    return this.load(query, query);
  }

  exportSnapshot(filters: BranchAttendanceFilters): Promise<BranchAttendanceSnapshot> {
    return this.load(filters);
  }

  private load(query: BranchAttendanceFilters, pagination?: Pick<BranchAttendanceQuery, 'page' | 'limit'>): Promise<BranchAttendanceSnapshot> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const branch = (await client.query<BranchAttendanceSnapshot['branch']>(
        'SELECT id,name,time_zone AS "timeZone" FROM branches WHERE id=$1', [query.branchId])).rows[0];
      if (!branch) throw new NotFoundError('Sucursal no encontrada.');
      const isActive = query.employeeStatus === 'active';
      const totalEmployees = (await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM employees
        WHERE branch_id=$1 AND is_active=$2 AND identification_status <> 'merged'`, [query.branchId, isActive])).rows[0].count;
      const page = pagination ? Math.min(pagination.page, Math.max(1, Math.ceil(totalEmployees / pagination.limit))) : 1;
      const employees = (await client.query<EmployeeRow>(`SELECT ${employeeSelectColumns} FROM employees
        WHERE branch_id=$1 AND is_active=$2 AND identification_status <> 'merged'
        ORDER BY name, employee_number NULLS LAST, id LIMIT $3::int OFFSET $4::int`,
      [query.branchId, isActive, pagination?.limit ?? null, pagination ? (page - 1) * pagination.limit : 0])).rows.map(mapEmployeeRow);
      const histories = await loadEmployeeAttendanceHistories(client, employees.map((employee) => employee.id), query);
      return { branch, employees, histories, page, totalEmployees };
    });
  }
}
