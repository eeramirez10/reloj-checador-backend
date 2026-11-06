import { z } from 'zod';
import { AppError } from '../../domain/errors/app-error.js';
import { canAccessBranch, type AccessResource, type AuthPrincipal } from '../../domain/entities/auth.js';
import type { AccessControl } from '../../domain/datasources/access-control.js';
import type { Database } from '../database/database.js';
import { accessContext, branchScopeSql } from './access-context.js';

const resourceQueries: Record<AccessResource,string> = {
  branch: 'SELECT id AS branch_id FROM branches WHERE id=$1',
  employee: 'SELECT branch_id FROM employees WHERE id=$1',
  device: 'SELECT branch_id FROM devices WHERE id=$1 AND deleted_at IS NULL',
  schedule: 'SELECT branch_id FROM work_schedules WHERE id=$1',
  clockRecord: `SELECT d.branch_id FROM device_users u JOIN devices d ON d.id=u.device_id WHERE u.id=$1
    UNION SELECT e.branch_id FROM device_users u JOIN employees e ON e.id=u.employee_id WHERE u.id=$1`,
  leave: `SELECT branch_id FROM leave_requests WHERE id=$1 UNION SELECT e.branch_id FROM employees e JOIN leave_requests r ON r.employee_id=e.id WHERE r.id=$1
    UNION SELECT (day->>'branchId')::uuid FROM leave_requests r CROSS JOIN LATERAL jsonb_array_elements(r.details->'days') day WHERE r.id=$1`,
};

export class BranchAccessControl implements AccessControl {
  constructor(private readonly database: Database) {}
  run<T>(callback: () => T) { return accessContext.run(callback); }
  set(principal: AuthPrincipal) { accessContext.set(principal); }
  current() { return accessContext.current(); }
  async assertResource(kind: AccessResource, id: string) {
    z.string().uuid().parse(id);
    const principal = this.current();
    if (!principal) throw new AppError('Inicia sesión.', 'UNAUTHORIZED');
    const rows = (await this.database.query<{ branch_id: string | null }>(resourceQueries[kind], [id])).rows;
    if (!rows.length || rows.some(row => !canAccessBranch(principal, row.branch_id))) throw new AppError('El recurso no está disponible en tus sucursales autorizadas.', 'FORBIDDEN');
    if (kind === 'clockRecord' && principal.role !== 'admin') {
      const owner = (await this.database.query<{ employee_id: string | null }>('SELECT employee_id FROM device_users WHERE id=$1',[id])).rows[0];
      if (owner?.employee_id) await this.assertEmployeeHistory(owner.employee_id);
    }
  }
  async assertEmployeeHistory(id: string) {
    if ((await this.database.query(`WITH subjects AS (SELECT $1::uuid AS id UNION SELECT source_employee_id FROM employee_merge_events WHERE target_employee_id=$1),
      history_branches AS (SELECT branch_id FROM branch_assignments WHERE employee_id IN (SELECT id FROM subjects)
        UNION SELECT d.branch_id FROM device_users u JOIN devices d ON d.id=u.device_id WHERE u.employee_id IN (SELECT id FROM subjects)
        UNION SELECT branch_id FROM attendance_evaluations WHERE subject_id IN (SELECT id FROM subjects))
      SELECT branch_id FROM history_branches WHERE NOT (${branchScopeSql('branch_id')}) LIMIT 1`, [id])).rows.length) {
      throw new AppError('El historial incluye otra sucursal. Se requiere acceso a todas las sucursales del historial.', 'FORBIDDEN');
    }
  }
}
