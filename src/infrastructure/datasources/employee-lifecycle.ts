import { randomUUID } from 'node:crypto';
import type { Queryable } from '../database/database.js';
import { ConfigurationError } from '../../domain/errors/app-error.js';
import { formatDateTimeInTimeZone } from '../../domain/entities/attendance-summary.js';
import { assertEditableEmployee, employeeStatusTransition } from '../../domain/entities/employee-lifecycle.js';

type LifecycleRow = {
  id: string; is_active: boolean; termination_date: string | null;
  identification_status: string; time_zone: string; original_data: Record<string, unknown>;
};

export class EmployeeLifecycle {
  constructor(private readonly database: Queryable) {}

  private async getCurrent(id: string): Promise<LifecycleRow> {
    const row = (await this.database.query<LifecycleRow>(`SELECT e.id, e.is_active, e.termination_date::text, e.identification_status,
      COALESCE(b.time_zone, 'America/Mexico_City') AS time_zone, to_jsonb(e) AS original_data
      FROM employees e LEFT JOIN branches b ON b.id = e.branch_id WHERE e.id = $1 FOR UPDATE OF e`, [id])).rows[0];
    if (!row) throw new ConfigurationError('Empleado no encontrado.');
    assertEditableEmployee(row.identification_status);
    return row;
  }

  async recordInitial(id: string, now = new Date()): Promise<void> {
    const row = await this.getCurrent(id);
    await this.database.query(`INSERT INTO employee_status_events
      (id,employee_id,event_type,is_active,local_date,time_zone,termination_date,original_data,created_at)
      SELECT $1,$2,'initial',$3,$4,$5,$6,$7,$8
      WHERE NOT EXISTS (SELECT 1 FROM employee_status_events WHERE employee_id = $2)`,
    [randomUUID(), id, row.is_active, formatDateTimeInTimeZone(now, row.time_zone).slice(0, 10), row.time_zone,
      row.termination_date, JSON.stringify(row.original_data), now]);
  }

  async setActive(id: string, isActive: boolean, now = new Date()): Promise<boolean> {
    const row = await this.getCurrent(id);
    const transition = employeeStatusTransition({ isActive: row.is_active, terminationDate: row.termination_date }, isActive, row.time_zone, now);
    if (!transition) return false;
    await this.database.query(`INSERT INTO employee_status_events
      (id,employee_id,event_type,previous_is_active,is_active,local_date,time_zone,previous_termination_date,termination_date,original_data,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), id, transition.eventType,
      transition.previousIsActive, isActive, transition.localDate, transition.timeZone, transition.previousTerminationDate,
      transition.terminationDate, JSON.stringify(row.original_data), now]);
    await this.database.query('UPDATE employees SET is_active = $2, termination_date = $3, updated_at = $4 WHERE id = $1', [id, isActive, transition.terminationDate, now]);
    return true;
  }
}
