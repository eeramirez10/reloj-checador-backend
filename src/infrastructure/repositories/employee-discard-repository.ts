import { randomUUID } from 'node:crypto';
import type { EmployeeDiscardRepository } from '../../domain/repositories/employee-discard-repository.js';
import { canAccessBranch,type AuthPrincipal } from '../../domain/entities/auth.js';
import { AppError,ConfigurationError,ConflictError } from '../../domain/errors/app-error.js';
import type { Database,Queryable } from '../database/database.js';

export class PrismaEmployeeDiscardRepository implements EmployeeDiscardRepository {
  constructor(private readonly database: Pick<Database,'transaction'>) {}

  private async devices(client: Queryable,id: string) {
    return (await client.query<{ id: string }>('SELECT DISTINCT device_id AS id FROM device_users WHERE employee_id=$1 ORDER BY device_id',[id])).rows.map(row => row.id);
  }

  discard(id: string,actor: AuthPrincipal,reason: string) {
    return this.database.transaction(async client => {
      const account = (await client.query<{ role: string; is_active: boolean; version: number }>('SELECT role,is_active,version FROM auth_accounts WHERE id=$1 FOR SHARE',[actor.id])).rows[0];
      if (!account?.is_active || !['admin','hr'].includes(account.role) || account.version!==actor.version || account.role!==actor.role) throw new AppError('Tu cuenta cambió. Inicia sesión nuevamente.', 'FORBIDDEN');
      const devices = await this.devices(client,id);
      // Compartimos los bloqueos de ingestión antes de bloquear al empleado.
      for (const deviceId of devices) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))::text',[`attendance-source:${deviceId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-identification'))::text");
      const employee = (await client.query<{ identification_status: string; discarded_at: Date | null; branch_id: string | null }>('SELECT identification_status,discarded_at,branch_id FROM employees WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (!employee || !canAccessBranch(actor,employee.branch_id)) throw new AppError('El empleado no está disponible en tus sucursales.', 'FORBIDDEN');
      if (employee.identification_status!=='pending') throw new ConfigurationError('Solo se pueden eliminar registros pendientes de identificar.');
      const currentDevices = await this.devices(client,id);
      if (currentDevices.some(device => !devices.includes(device))) throw new ConflictError('Los vínculos del reloj cambiaron. Actualiza la lista e intenta nuevamente.');
      const branches = (await client.query<{ branch_id: string | null }>(`SELECT branch_id FROM branch_assignments WHERE employee_id=$1
        UNION SELECT d.branch_id FROM device_users u JOIN devices d ON d.id=u.device_id WHERE u.employee_id=$1
        UNION SELECT branch_id FROM attendance_evaluations WHERE subject_id=$1 OR employee_id=$1`,[id])).rows;
      if (branches.some(branch => !canAccessBranch(actor,branch.branch_id))) throw new AppError('El historial incluye otra sucursal. Se requiere acceso a todas sus sucursales.', 'FORBIDDEN');
      const attendance = (await client.query(`SELECT a.id FROM device_users u JOIN attendance_logs a ON a.device_id=u.device_id AND a.user_id=u.device_user_id WHERE u.employee_id=$1 LIMIT 1`,[id])).rows;
      if (attendance.length) throw new ConfigurationError('Este registro tiene checadas y no puede eliminarse de la lista.');
      const history = (await client.query(`SELECT EXISTS(SELECT 1 FROM employee_merge_events WHERE source_employee_id=$1 OR target_employee_id=$1)
        OR EXISTS(SELECT 1 FROM leave_requests WHERE employee_id=$1 OR manager_id=$1 OR resolved_by=$1)
        OR EXISTS(SELECT 1 FROM vacation_movements WHERE employee_id=$1)
        OR EXISTS(SELECT 1 FROM auth_accounts WHERE employee_id=$1)
        OR EXISTS(SELECT 1 FROM attendance_evaluations WHERE subject_id=$1 OR employee_id=$1) AS protected`,[id])).rows[0].protected;
      if (history) throw new ConfigurationError('La ficha tiene historial de negocio y requiere revisión antes de eliminarse.');
      if (employee.discarded_at) return;
      await client.query('UPDATE employees SET discarded_at=NOW(),updated_at=NOW() WHERE id=$1',[id]);
      await client.query("INSERT INTO employee_discard_events(id,employee_id,kind,actor_account_id,reason) VALUES($1,$2,'discarded',$3,$4)",[randomUUID(),id,actor.id,reason]);
      await client.query("INSERT INTO auth_audit_events(id,account_id,action,target_id,metadata) VALUES($1,$2,'employee_discarded',$3,$4::jsonb)",[randomUUID(),actor.id,id,JSON.stringify({reason})]);
    });
  }
}
