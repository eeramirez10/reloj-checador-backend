import type { EmployeeAttendanceDatasource } from '../../domain/datasources/employee-attendance-datasource.js';
import type { EmployeeAttendanceHistory } from '../../domain/repositories/employee-attendance-repository.js';
import type { AttendancePeriod } from '../../domain/entities/employee-attendance.js';
import type { Database } from '../database/database.js';
import { scheduleVersionColumns } from './employee-scheduling-datasource.js';

export class PrismaEmployeeAttendanceDatasource implements EmployeeAttendanceDatasource {
  constructor(private readonly database: Database) {}

  history(employeeId: string, period: AttendancePeriod): Promise<EmployeeAttendanceHistory> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const branches = (await client.query<EmployeeAttendanceHistory['branches'][number]>(
        'SELECT id, name, time_zone AS "timeZone" FROM branches')).rows;
      const branchAssignments = (await client.query<EmployeeAttendanceHistory['branchAssignments'][number]>(
        'SELECT branch_id AS "branchId", effective_from::text AS "effectiveFrom" FROM branch_assignments WHERE employee_id=$1', [employeeId])).rows;
      const schedules = (await client.query<EmployeeAttendanceHistory['schedules'][number]>(`SELECT id, branch_id AS "branchId", name,
        effective_from::text AS "effectiveFrom", is_default AS "isDefault", settings, created_at AS "createdAt",
        superseded_from::text AS "supersededFrom" FROM work_schedules WHERE deleted_at IS NULL`)).rows;
      const assignments = (await client.query<EmployeeAttendanceHistory['assignments'][number]>(
        'SELECT schedule_id AS "scheduleId", effective_from::text AS "effectiveFrom" FROM schedule_assignments WHERE employee_id=$1', [employeeId])).rows;
      const employeeSchedules = (await client.query<EmployeeAttendanceHistory['employeeSchedules'][number]>(
        `SELECT ${scheduleVersionColumns} FROM employee_schedule_versions WHERE employee_id=$1 ORDER BY created_at DESC,id DESC`, [employeeId])).rows;
      const evaluations = (await client.query<EmployeeAttendanceHistory['evaluations'][number]>(`SELECT date::text,
        branch_id AS "branchId", result FROM attendance_evaluations WHERE subject_id=$1 AND active
        AND date BETWEEN $2::date AND $3::date ORDER BY date`, [employeeId, period.from, period.to])).rows;
      return { branches, branchAssignments, schedules, assignments, employeeSchedules, evaluations };
    });
  }
}
