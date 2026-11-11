import { randomUUID } from 'node:crypto';
import type { EvaluationDatasource } from '../../domain/datasources/evaluation-datasource.js';
import type { EvaluationSession, EvaluationSnapshot, EvaluationWrite, SubjectLog } from '../../domain/repositories/evaluation-repository.js';
import type { CalculatedDeduction, DailyEvaluation } from '../../domain/entities/schedule-evaluator.js';
import type { BranchPolicy, WorkSchedule } from '../../domain/entities/organization.js';
import type { ReportFilters } from '../../domain/dtos/filters.js';
import { companyFilterSql } from './company-filter.js';
import type { Database, Queryable } from '../database/database.js';
import type { Prisma } from '../database/generated/client.js';
import type { EmployeeScheduleVersion } from '../../domain/entities/employee-scheduling.js';
import { scheduleVersionColumns } from './employee-scheduling-datasource.js';
import { leaveRequestColumns } from './leave-columns.js';
import type { LeaveRequest } from '../../domain/entities/leave.js';
import { branchScopeSql } from '../security/access-context.js';
import { BatchedEvaluationSession } from './batched-evaluation-session.js';

export function createEvaluationSession(client: Queryable): EvaluationSession {
  return new BatchedEvaluationSession(client, new PrismaEvaluationSession(client));
}

export class PrismaEvaluationSession implements EvaluationSession {
  constructor(private readonly database: Queryable) {}

  async snapshot(): Promise<EvaluationSnapshot> {
    const branches = (await this.database.query<EvaluationSnapshot['branches'][number]>('SELECT id, name, time_zone AS "timeZone" FROM branches')).rows;
    const policies = (await this.database.query<BranchPolicy>('SELECT id, branch_id AS "branchId", effective_from::text AS "effectiveFrom", settings, created_at AS "createdAt", superseded_from::text AS "supersededFrom" FROM branch_policies WHERE deleted_at IS NULL ORDER BY effective_from DESC, created_at DESC')).rows;
    const schedules = (await this.database.query<WorkSchedule>('SELECT id, branch_id AS "branchId", name, effective_from::text AS "effectiveFrom", is_default AS "isDefault", settings, created_at AS "createdAt", superseded_from::text AS "supersededFrom" FROM work_schedules WHERE deleted_at IS NULL ORDER BY effective_from DESC, created_at DESC')).rows;
    const assignments = (await this.database.query<EvaluationSnapshot['assignments'][number]>('SELECT employee_id AS "employeeId", device_user_id AS "deviceUserId", schedule_id AS "scheduleId", effective_from::text AS "effectiveFrom" FROM schedule_assignments')).rows;
    const branchAssignments = (await this.database.query<EvaluationSnapshot['branchAssignments'][number]>('SELECT COALESCE(employee_id, device_user_id) AS "targetId", branch_id AS "branchId", effective_from::text AS "effectiveFrom" FROM branch_assignments WHERE device_id IS NULL')).rows;
    const logs = (await this.database.query<SubjectLog>(`SELECT a.id, u.employee_id AS "employeeId", u.id AS "deviceUserId", COALESCE(u.employee_id, u.id) AS "subjectId",
      COALESCE(e.name, u.display_name, u.name, u.device_user_id) AS name, e.employee_number AS "employeeNumber", u.device_user_id AS "userId",
      COALESCE(e.branch_id, u.branch_id, a.branch_id) AS "branchId", a.occurred_at AS "occurredAt"
      FROM attendance_logs a JOIN device_users u ON u.device_id = a.device_id AND u.device_user_id = a.user_id
      LEFT JOIN employees e ON e.id = u.employee_id
      WHERE a.occurred_at <= NOW() AND NOT (a.device_log_id IS NULL AND a.raw_data ? 'userSn'
        AND EXISTS (SELECT 1 FROM attendance_logs newer WHERE newer.device_id = a.device_id AND newer.device_log_id = a.raw_data ->> 'userSn'
          AND newer.user_id = a.user_id AND newer.occurred_at = a.occurred_at))
      ORDER BY a.occurred_at, a.id`)).rows;
    const employeeSchedules = (await this.database.query<EmployeeScheduleVersion>(`SELECT ${scheduleVersionColumns} FROM employee_schedule_versions ORDER BY created_at DESC,id DESC`)).rows;
    const approvedLeaves = (await this.database.query<LeaveRequest>(`SELECT ${leaveRequestColumns} FROM leave_requests WHERE status='approved'`)).rows;
    const leaveSubjects = (await this.database.query<SubjectLog>(`SELECT e.id AS "employeeId",e.id AS "subjectId",e.id AS "deviceUserId",e.name,
      e.employee_number AS "employeeNumber",'' AS "userId",e.branch_id AS "branchId",NOW() AS "occurredAt",e.id AS id
      FROM employees e WHERE EXISTS (SELECT 1 FROM leave_requests r WHERE r.employee_id=e.id AND r.status='approved')`)).rows;
    return { branches, policies, schedules, assignments, branchAssignments, logs, employeeSchedules, approvedLeaves, leaveSubjects };
  }

  async saveEvaluation(input: EvaluationWrite): Promise<string> {
    const result = input.result as unknown as Prisma.InputJsonValue;
    const date = new Date(`${input.date}T00:00:00Z`);
    const row = await this.database.prisma.attendance_evaluations.upsert({
      where: { subject_id_date: { subject_id: input.subjectId, date } },
      create: {
        id: randomUUID(), subject_id: input.subjectId, employee_id: input.employeeId, device_user_id: input.deviceUserId,
        date, branch_id: input.branchId, schedule_id: input.scheduleId, policy_id: input.policyId, result,
      },
      update: { branch_id: input.branchId, schedule_id: input.scheduleId, policy_id: input.policyId, result, active: true, updated_at: new Date() },
    });
    return row.id;
  }

  async saveIncident(evaluationId: string, subjectId: string, policyId: string, incident: DailyEvaluation['incidents'][number]): Promise<string> {
    const data = { policy_id: policyId, log_id: incident.logId, occurred_at: new Date(incident.occurredAt), minutes: incident.minutes };
    return (await this.database.prisma.attendance_incidents.upsert({
      where: { evaluation_id_kind: { evaluation_id: evaluationId, kind: incident.kind } },
      create: { id: randomUUID(), evaluation_id: evaluationId, subject_id: subjectId, kind: incident.kind, ...data },
      update: { ...data, active: true },
    })).id;
  }

  async saveDeduction(subjectId: string, deduction: CalculatedDeduction): Promise<string> {
    const data = {
      policy_id: deduction.policyId, category: deduction.category, window_start: new Date(`${deduction.windowStart}T00:00:00Z`),
      window_end: new Date(`${deduction.windowEnd}T00:00:00Z`), incident_ids: deduction.incidentIds,
    };
    return (await this.database.prisma.attendance_deductions.upsert({
      where: { trigger_incident_id: deduction.triggerIncidentId },
      create: { id: randomUUID(), subject_id: subjectId, trigger_incident_id: deduction.triggerIncidentId, ...data },
      update: { ...data, voided_at: null },
    })).id;
  }

  async reconcile(activeIncidentIds: string[], activeDeductionIds: string[], activeEvaluationIds: string[]): Promise<void> {
    await this.database.prisma.attendance_incidents.updateMany({ where: { active: true, id: { notIn: activeIncidentIds } }, data: { active: false } });
    await this.database.prisma.attendance_deductions.updateMany({ where: { voided_at: null, id: { notIn: activeDeductionIds } }, data: { voided_at: new Date() } });
    await this.database.prisma.attendance_evaluations.updateMany({ where: { active: true, id: { notIn: activeEvaluationIds } }, data: { active: false } });
  }

  async updateCounters(id: string, counters: { arrival: number; meal: number }, deductionDays: number): Promise<void> {
    await this.database.query('UPDATE attendance_evaluations SET result = result || $2::jsonb WHERE id = $1', [id, JSON.stringify({ counters, deductionDays })]);
  }
}

export class PrismaEvaluationDatasource implements EvaluationDatasource {
  constructor(private readonly database: Database, private readonly refreshBranches: (client: Queryable) => Promise<void>) {}

  transaction<T>(operation: (session: EvaluationSession) => Promise<T>): Promise<T> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('attendance-evaluation'))::text");
      await this.refreshBranches(client);
      return operation(createEvaluationSession(client));
    });
  }

  async report(filters: ReportFilters) {
    return (await this.database.query(`SELECT ev.id, ev.subject_id AS "subjectId", ev.employee_id AS "employeeId", ev.device_user_id AS "deviceUserId",
      ev.date::text, ev.branch_id AS "branchId", ev.result,e.company_id AS "companyId",c.name AS "companyName",
      (SELECT jsonb_build_object('deviceId', a.device_id, 'userId', a.user_id, 'hasPhoto', TRUE)
        FROM (SELECT value ->> 'id' AS log_id FROM jsonb_array_elements(ev.result -> 'punches')
          UNION SELECT value ->> 'entryLogId' FROM jsonb_array_elements(COALESCE(ev.result -> 'routes','[]'::jsonb))
          UNION SELECT value ->> 'exitLogId' FROM jsonb_array_elements(COALESCE(ev.result -> 'routes','[]'::jsonb))) sources
        JOIN attendance_logs a ON a.id = sources.log_id::uuid
        JOIN device_user_photos p ON p.device_id = a.device_id AND p.device_user_id = a.user_id
        ORDER BY a.occurred_at DESC, a.id DESC LIMIT 1) AS photo
      FROM attendance_evaluations ev LEFT JOIN employees e ON e.id=ev.employee_id LEFT JOIN companies c ON c.id=e.company_id
      WHERE (${branchScopeSql('ev.branch_id')}) AND ev.active AND ev.date BETWEEN $1::date AND $2::date
      AND ($3::uuid IS NULL OR ev.branch_id = $3) AND ($4::uuid IS NULL OR ev.subject_id = $4)
      AND ${companyFilterSql('e.company_id',5)}
      ORDER BY ev.date DESC,
        ((ev.result ->> 'entry')::timestamptz AT TIME ZONE COALESCE(ev.result ->> 'timeZone', 'America/Mexico_City')) ASC NULLS LAST,
        ev.id`,
    [filters.from, filters.to, filters.branchId ?? null, filters.subjectId ?? null,filters.companyId ?? null])).rows;
  }

  async deductions(filters: ReportFilters) {
    return (await this.database.query(`SELECT d.id, d.subject_id AS "subjectId", d.category, d.salary_days AS "salaryDays",
      d.window_start::text AS "windowStart", d.window_end::text AS "windowEnd", d.incident_ids AS "incidentIds", d.voided_at AS "voidedAt",
      i.occurred_at AS "occurredAt", ev.result ->> 'name' AS name, ev.result ->> 'branchName' AS "branchName", ev.result ->> 'timeZone' AS "timeZone",
      e.company_id AS "companyId",c.name AS "companyName"
      FROM attendance_deductions d JOIN attendance_incidents i ON i.id = d.trigger_incident_id
      JOIN attendance_evaluations ev ON ev.id = i.evaluation_id LEFT JOIN employees e ON e.id=ev.employee_id LEFT JOIN companies c ON c.id=e.company_id
      WHERE (${branchScopeSql('ev.branch_id')}) AND ev.date BETWEEN $1::date AND $2::date
      AND ($3::uuid IS NULL OR ev.branch_id = $3) AND ($4::uuid IS NULL OR d.subject_id = $4) AND ${companyFilterSql('e.company_id',5)} ORDER BY i.occurred_at DESC`,
    [filters.from, filters.to, filters.branchId ?? null, filters.subjectId ?? null,filters.companyId ?? null])).rows;
  }
}
