import type { Queryable } from '../database/database.js';
import type { AttendancePeriod } from '../../domain/entities/employee-attendance.js';
import { AppError } from '../../domain/errors/app-error.js';
import { branchScopeSql, scopedBranchIds } from './access-context.js';

export async function assertAttendanceHistoryAccess(client: Queryable, ids: string[], period: AttendancePeriod) {
  if (!scopedBranchIds() || !ids.length) return;
  const outside = (await client.query(`WITH timeline AS (
    SELECT branch_id,effective_from,LEAD(effective_from) OVER(PARTITION BY employee_id ORDER BY effective_from) AS until_date
    FROM branch_assignments WHERE employee_id=ANY($1::uuid[]))
    SELECT branch_id FROM timeline WHERE effective_from<=$3::date AND (until_date IS NULL OR until_date>$2::date)
      AND NOT (${branchScopeSql('branch_id')})
    UNION ALL SELECT branch_id FROM attendance_evaluations WHERE subject_id=ANY($1::uuid[]) AND active
      AND date BETWEEN $2::date AND $3::date AND NOT (${branchScopeSql('branch_id')}) LIMIT 1`, [ids,period.from,period.to])).rows;
  if (outside.length) throw new AppError('El periodo contiene asistencia de otra sucursal. Selecciona un periodo autorizado o solicita acceso a esa sucursal.', 'FORBIDDEN');
}
