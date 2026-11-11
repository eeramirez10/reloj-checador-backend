import { randomUUID } from 'node:crypto';
import type { EmployeeSchedulingDatasource } from '../../domain/datasources/employee-scheduling-datasource.js';
import type { EmployeeScheduleInput, EmployeeScheduleVersion, SchedulingContext } from '../../domain/entities/employee-scheduling.js';
import { effectiveVersion } from '../../domain/entities/employee-scheduling.js';
import type { WorkSchedule } from '../../domain/entities/organization.js';
import { formatDateTimeInTimeZone } from '../../domain/entities/attendance-summary.js';
import { ConfigurationError, ConflictError } from '../../domain/errors/app-error.js';
import type { Queryable } from '../database/database.js';
import { DEFAULT_OVERTIME_SETTINGS, type OvertimeSettings } from '../../domain/entities/overtime.js';

export const scheduleVersionColumns = `id, employee_id AS "employeeId", effective_from::text AS "effectiveFrom", work_hours AS "workHours", meal,
  COALESCE(meal_mode, CASE WHEN meal IS NULL THEN 'automatic' ELSE 'individual' END) AS "mealMode",
  recognition_margin_minutes AS "recognitionMarginMinutes", recognition_margin_inherited AS "recognitionMarginInherited", overtime_settings AS overtime, created_at AS "createdAt", source`;
const scheduleColumns = 'id, branch_id AS "branchId", name, effective_from::text AS "effectiveFrom", is_default AS "isDefault", settings, created_at AS "createdAt", superseded_from::text AS "supersededFrom"';

export class PrismaEmployeeSchedulingDatasource implements EmployeeSchedulingDatasource {
  constructor(private readonly database: Queryable) {}

  async lock(employeeId: string): Promise<void> {
    await this.database.query('SELECT pg_advisory_xact_lock(hashtext($1))::text', [`employee-scheduling:${employeeId}`]);
    const employee = (await this.database.query<{ identification_status: string }>('SELECT identification_status FROM employees WHERE id=$1 AND discarded_at IS NULL FOR UPDATE', [employeeId])).rows[0];
    if (!employee || employee.identification_status === 'merged') throw new ConfigurationError('Empleado no encontrado o ficha histórica.');
  }

  async context(employeeId: string, date?: string): Promise<SchedulingContext> {
    const employee = (await this.database.query<{ branchId: string | null; timeZone: string; firstAttendanceDate: string | null }>(`
      SELECT e.branch_id AS "branchId", COALESCE(b.time_zone,'America/Mexico_City') AS "timeZone",
        (SELECT MIN((a.occurred_at AT TIME ZONE COALESCE(ab.time_zone,b.time_zone,'America/Mexico_City'))::date)::text
          FROM device_users u JOIN attendance_logs a ON a.device_id=u.device_id AND a.user_id=u.device_user_id
          LEFT JOIN branches ab ON ab.id=a.branch_id WHERE u.employee_id=e.id) AS "firstAttendanceDate"
      FROM employees e LEFT JOIN branches b ON b.id=e.branch_id WHERE e.id=$1 AND e.discarded_at IS NULL AND e.identification_status <> 'merged'`, [employeeId])).rows[0];
    if (!employee) throw new ConfigurationError('Empleado no encontrado.');
    const day = date ?? formatDateTimeInTimeZone(new Date(), employee.timeZone).slice(0, 10);
    const branchHistory = (await this.database.query<{ branchId: string; effectiveFrom: string }>(
      'SELECT branch_id AS "branchId", effective_from::text AS "effectiveFrom" FROM branch_assignments WHERE employee_id=$1', [employeeId])).rows;
    const branchId = branchHistory.length ? effectiveVersion(branchHistory, day)?.branchId : employee.branchId;
    const schedules = (await this.database.query<WorkSchedule>(`SELECT ${scheduleColumns} FROM work_schedules WHERE branch_id=$1 AND deleted_at IS NULL ORDER BY effective_from DESC,created_at DESC`, [branchId ?? null])).rows;
    const assignment = (await this.database.query<{ scheduleId: string | null }>(
      'SELECT schedule_id AS "scheduleId" FROM schedule_assignments WHERE employee_id=$1 AND effective_from <= $2::date ORDER BY effective_from DESC,created_at DESC LIMIT 1', [employeeId, day])).rows[0];
    const assignedSchedule = assignment?.scheduleId ? (await this.database.query<WorkSchedule>(`SELECT ${scheduleColumns} FROM work_schedules WHERE id=$1 AND deleted_at IS NULL`, [assignment.scheduleId])).rows[0] : undefined;
    const history = (await this.database.query<EmployeeScheduleVersion>(`SELECT ${scheduleVersionColumns} FROM employee_schedule_versions WHERE employee_id=$1 ORDER BY created_at DESC,id DESC`, [employeeId])).rows;
    return { employeeId, date: day, timeZone: employee.timeZone, firstAttendanceDate: employee.firstAttendanceDate,
      baseSchedule: effectiveVersion(schedules.filter((schedule) => schedule.isDefault), day),
      assignedSchedule: assignedSchedule && assignedSchedule.effectiveFrom <= day ? assignedSchedule : undefined,
      version: effectiveVersion(history, day), latestVersionId: history[0]?.id ?? null, history };
  }

  async append(employeeId: string, input: EmployeeScheduleInput): Promise<void> {
    const latest = (await this.database.query<{ id: string }>('SELECT id FROM employee_schedule_versions WHERE employee_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [employeeId])).rows[0];
    if (input.expectedVersionId !== undefined && input.expectedVersionId !== (latest?.id ?? null)) {
      throw new ConflictError('Otro cambio actualizó el horario del empleado. Actualiza la ficha antes de guardar.');
    }
    const previous = input.overtime === undefined ? (await this.database.query<{ overtime: OvertimeSettings }>(`SELECT overtime_settings AS overtime
      FROM employee_schedule_versions WHERE employee_id=$1 AND effective_from <= $2::date ORDER BY effective_from DESC,created_at DESC,id DESC LIMIT 1`, [employeeId,input.effectiveFrom])).rows[0]?.overtime : undefined;
    await this.database.query(`INSERT INTO employee_schedule_versions (id,employee_id,effective_from,work_hours,meal,recognition_margin_minutes,meal_mode,recognition_margin_inherited,overtime_settings,created_at)
      VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9::jsonb,clock_timestamp())`, [randomUUID(), employeeId, input.effectiveFrom,
      input.workHours ? JSON.stringify(input.workHours) : null, input.meal ? JSON.stringify(input.meal) : null, input.recognitionMarginMinutes,
      input.mealMode ?? (input.meal ? 'individual' : 'automatic'), input.recognitionMarginInherited ?? false,
      JSON.stringify(input.overtime ?? previous ?? DEFAULT_OVERTIME_SETTINGS)]);
  }
}
