import type { EmployeeAttendanceDatasource } from '../../domain/datasources/employee-attendance-datasource.js';
import type { EmployeeAttendanceHistory } from '../../domain/repositories/employee-attendance-repository.js';
import type { AttendancePeriod } from '../../domain/entities/employee-attendance.js';
import type { Database, Queryable } from '../database/database.js';
import { scheduleVersionColumns } from './employee-scheduling-datasource.js';

export class PrismaEmployeeAttendanceDatasource implements EmployeeAttendanceDatasource {
  constructor(private readonly database: Database) {}

  history(employeeId: string, period: AttendancePeriod): Promise<EmployeeAttendanceHistory> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return (await loadEmployeeAttendanceHistories(client, [employeeId], period)).get(employeeId)!;
    });
  }
}

export async function loadEmployeeAttendanceHistories(client: Queryable, employeeIds: string[], period: AttendancePeriod): Promise<Map<string, EmployeeAttendanceHistory>> {
  const histories = new Map<string, EmployeeAttendanceHistory>();
  if (!employeeIds.length) return histories;
  const branches = (await client.query<EmployeeAttendanceHistory['branches'][number]>(
    'SELECT id, name, time_zone AS "timeZone" FROM branches')).rows;
  const schedules = (await client.query<EmployeeAttendanceHistory['schedules'][number]>(`SELECT id, branch_id AS "branchId", name,
    effective_from::text AS "effectiveFrom", is_default AS "isDefault", settings, created_at AS "createdAt",
    superseded_from::text AS "supersededFrom" FROM work_schedules WHERE deleted_at IS NULL`)).rows;
  const branchAssignments = (await client.query<EmployeeAttendanceHistory['branchAssignments'][number] & { employeeId: string }>(
    'SELECT employee_id AS "employeeId", branch_id AS "branchId", effective_from::text AS "effectiveFrom" FROM branch_assignments WHERE employee_id=ANY($1::uuid[])', [employeeIds])).rows;
  const assignments = (await client.query<EmployeeAttendanceHistory['assignments'][number] & { employeeId: string }>(
    'SELECT employee_id AS "employeeId", schedule_id AS "scheduleId", effective_from::text AS "effectiveFrom" FROM schedule_assignments WHERE employee_id=ANY($1::uuid[])', [employeeIds])).rows;
  const employeeSchedules = (await client.query<EmployeeAttendanceHistory['employeeSchedules'][number]>(
    `SELECT ${scheduleVersionColumns} FROM employee_schedule_versions WHERE employee_id=ANY($1::uuid[]) ORDER BY created_at DESC,id DESC`, [employeeIds])).rows;
  const evaluations = (await client.query<EmployeeAttendanceHistory['evaluations'][number] & { employeeId: string }>(`SELECT subject_id AS "employeeId", date::text,
    branch_id AS "branchId", result FROM attendance_evaluations WHERE subject_id=ANY($1::uuid[]) AND active
    AND date BETWEEN $2::date AND $3::date ORDER BY date`, [employeeIds, period.from, period.to])).rows;
  for (const id of employeeIds) histories.set(id, { branches, schedules, branchAssignments: [], assignments: [], employeeSchedules: [], evaluations: [] });
  for (const { employeeId, ...assignment } of branchAssignments) histories.get(employeeId)!.branchAssignments.push(assignment);
  for (const { employeeId, ...assignment } of assignments) histories.get(employeeId)!.assignments.push(assignment);
  for (const version of employeeSchedules) histories.get(version.employeeId)!.employeeSchedules.push(version);
  for (const { employeeId, ...evaluation } of evaluations) histories.get(employeeId)!.evaluations.push(evaluation);
  return histories;
}
