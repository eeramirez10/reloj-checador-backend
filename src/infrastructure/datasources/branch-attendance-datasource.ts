import type { BranchAttendanceDatasource } from '../../domain/datasources/branch-attendance-datasource.js';
import type { BranchAttendanceFilters, BranchAttendanceQuery } from '../../domain/entities/branch-attendance.js';
import type { BranchAttendanceSnapshot } from '../../domain/repositories/branch-attendance-repository.js';
import { NotFoundError } from '../../domain/errors/not-found-error.js';
import type { Database } from '../database/database.js';
import { employeeSelectColumns, mapEmployeeRow, type EmployeeRow } from './employee-datasource.js';
import { loadEmployeeAttendanceHistories } from './employee-attendance-datasource.js';
import { assertAttendanceHistoryAccess } from '../security/attendance-history-access.js';
import { companyFilterSql } from './company-filter.js';
import type { CompanySelection } from '../../domain/entities/company.js';
import { branchScopeSql } from '../security/access-context.js';

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
      let companyFilter: CompanySelection | undefined;
      if (query.companyId === 'unassigned') companyFilter = { id: null,name: 'Sin empresa' };
      else if (query.companyId) {
        companyFilter = (await client.query<CompanySelection>('SELECT id,name FROM companies WHERE id=$1',[query.companyId])).rows[0];
        if (!companyFilter) throw new NotFoundError('Empresa no encontrada.');
      }
      const isActive = query.employeeStatus === 'active';
      const search = query.search?.trim() || undefined;
      const pattern = search ? `%${search.replace(/[\\%_]/g,'\\$&')}%` : null;
      const selection = `branch_id=$1 AND is_active=$2 AND identification_status<>'merged' AND discarded_at IS NULL AND ${companyFilterSql('company_id',3)}
        AND ($4::text IS NULL OR name ILIKE $4 OR EXISTS(SELECT 1 FROM device_users clock_user JOIN devices clock ON clock.id=clock_user.device_id
          WHERE clock_user.employee_id=employees.id AND (${branchScopeSql('clock.branch_id')}) AND clock_user.device_user_id ILIKE $4))`;
      const parameters = [query.branchId,isActive,query.companyId ?? null,pattern];
      const totalEmployees = (await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM employees
        WHERE ${selection}`, parameters)).rows[0].count;
      const page = pagination ? Math.min(pagination.page, Math.max(1, Math.ceil(totalEmployees / pagination.limit))) : 1;
      const employees = (await client.query<EmployeeRow>(`SELECT ${employeeSelectColumns()} FROM employees
        WHERE ${selection}
        ORDER BY name, employee_number NULLS LAST, id LIMIT $5::int OFFSET $6::int`,
      [...parameters,pagination?.limit ?? null, pagination ? (page - 1) * pagination.limit : 0])).rows.map(mapEmployeeRow);
      await assertAttendanceHistoryAccess(client, employees.map((employee) => employee.id), query);
      const histories = await loadEmployeeAttendanceHistories(client, employees.map((employee) => employee.id), query);
      return { branch, employees, histories, page, totalEmployees,...(companyFilter ? {companyFilter} : {}),...(search ? {search} : {}) };
    });
  }
}
