import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import type { Branch, BranchPolicy, WorkSchedule } from '../organization/schemas.js';
import { OrganizationRepository } from '../organization/organization-repository.js';
import { formatDateTimeInTimeZone } from './attendance-summary.js';
import { accumulateIncidents, evaluateDay, type CountedIncident, type DailyEvaluation } from './schedule-evaluator.js';

type SubjectLog = {
  id: string; employeeId: string | null; deviceUserId: string; subjectId: string; name: string;
  employeeNumber: string | null; userId: string; branchId: string | null; occurredAt: Date;
};
type BranchAssignment = { targetId: string; branchId: string; effectiveFrom: string };
type ScheduleAssignment = { employeeId: string | null; deviceUserId: string | null; scheduleId: string | null; effectiveFrom: string };

function effective<T extends { effectiveFrom: string; createdAt?: Date }>(items: T[], date: string): T | undefined {
  return items.filter((item) => item.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)
    || (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
}

export class AttendanceEvaluationService {
  constructor(private readonly database: Database, private readonly organization: OrganizationRepository) {}

  async recalculate(): Promise<{ evaluatedDays: number; deductions: number }> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('attendance-evaluation'))");
      await this.organization.refreshCurrentBranches(client);
      const branchRows = await client.query<Branch>('SELECT id, name, time_zone AS "timeZone" FROM branches');
      const policyRows = await client.query<BranchPolicy>('SELECT id, branch_id AS "branchId", effective_from::text AS "effectiveFrom", settings, created_at AS "createdAt" FROM branch_policies ORDER BY effective_from DESC, created_at DESC');
      const scheduleRows = await client.query<WorkSchedule>('SELECT id, branch_id AS "branchId", name, effective_from::text AS "effectiveFrom", is_default AS "isDefault", settings, created_at AS "createdAt" FROM work_schedules ORDER BY effective_from DESC, created_at DESC');
      const assignmentRows = await client.query<ScheduleAssignment>('SELECT employee_id AS "employeeId", device_user_id AS "deviceUserId", schedule_id AS "scheduleId", effective_from::text AS "effectiveFrom" FROM schedule_assignments');
      const historyRows = await client.query<BranchAssignment>('SELECT COALESCE(employee_id, device_user_id) AS "targetId", branch_id AS "branchId", effective_from::text AS "effectiveFrom" FROM branch_assignments WHERE device_id IS NULL');
      const logRows = await client.query<SubjectLog>(`SELECT a.id, u.employee_id AS "employeeId", u.id AS "deviceUserId", COALESCE(u.employee_id, u.id) AS "subjectId",
          COALESCE(e.name, u.display_name, u.name, u.device_user_id) AS name, e.employee_number AS "employeeNumber", u.device_user_id AS "userId",
          COALESCE(e.branch_id, u.branch_id, a.branch_id) AS "branchId", a.occurred_at AS "occurredAt"
          FROM attendance_logs a JOIN device_users u ON u.device_id = a.device_id AND u.device_user_id = a.user_id
          LEFT JOIN employees e ON e.id = u.employee_id
          WHERE a.occurred_at <= NOW() AND NOT (a.device_log_id IS NULL AND a.raw_data ? 'userSn'
            AND EXISTS (SELECT 1 FROM attendance_logs newer WHERE newer.device_id = a.device_id AND newer.device_log_id = a.raw_data ->> 'userSn'))
          ORDER BY a.occurred_at, a.id`);
      const branches = new Map(branchRows.rows.map((branch) => [branch.id, branch]));
      const schedules = new Map(scheduleRows.rows.map((schedule) => [schedule.id, schedule]));
      const groups = new Map<string, { date: string; branch?: Branch; logs: SubjectLog[] }>();
      for (const log of logRows.rows) {
        const history = historyRows.rows.filter((assignment) => assignment.targetId === log.subjectId);
        const currentAssignment = history.filter((assignment) => assignment.effectiveFrom <= formatDateTimeInTimeZone(log.occurredAt,
          branches.get(assignment.branchId)?.timeZone ?? 'America/Mexico_City').slice(0, 10))
          .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom))[0];
        const branchId = history.length ? currentAssignment?.branchId : log.branchId;
        const branch = branches.get(branchId ?? '');
        const date = formatDateTimeInTimeZone(log.occurredAt, branch?.timeZone ?? 'America/Mexico_City').slice(0, 10);
        const key = `${log.subjectId}:${date}`;
        const group = groups.get(key) ?? { date, branch, logs: [] };
        group.logs.push(log);
        groups.set(key, group);
      }
      const activeIncidentIds: string[] = [];
      const incidentsBySubject = new Map<string, CountedIncident[]>();
      const evaluations: Array<{ id: string; subjectId: string; date: string }> = [];
      for (const group of groups.values()) {
        const first = group.logs[0];
        const policy = effective(policyRows.rows.filter((item) => item.branchId === group.branch?.id), group.date);
        const assignment = effective(assignmentRows.rows.filter((item) => first.employeeId
          ? item.employeeId === first.employeeId : item.deviceUserId === first.deviceUserId), group.date);
        const assigned = assignment?.scheduleId ? schedules.get(assignment.scheduleId) : undefined;
        const schedule = assigned && assigned.effectiveFrom <= group.date ? assigned
          : effective(scheduleRows.rows.filter((item) => item.branchId === group.branch?.id && item.isDefault), group.date);
        const zone = group.branch?.timeZone ?? 'America/Mexico_City';
        const daily: DailyEvaluation = policy && schedule ? evaluateDay(group.date, group.logs, schedule.settings, policy.settings, zone)
          : { date: group.date, status: 'unconfigured', punches: group.logs.map((log) => ({ id: log.id, occurredAt: log.occurredAt.toISOString(), localTime: formatDateTimeInTimeZone(log.occurredAt, zone), movement: 'unclassified' })),
            issues: ['Asigna una sucursal, un horario y reglas vigentes para calcular esta jornada.'], incidents: [] };
        const result = { ...daily, name: first.name, employeeNumber: first.employeeNumber, userIds: [...new Set(group.logs.map((log) => log.userId))],
          branchName: group.branch?.name, scheduleName: schedule?.name, timeZone: zone, policy: policy?.settings };
        const evaluation = (await client.query<{ id: string }>(`INSERT INTO attendance_evaluations
          (id, subject_id, employee_id, device_user_id, date, branch_id, schedule_id, policy_id, result)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (subject_id, date) DO UPDATE SET
          branch_id = EXCLUDED.branch_id, schedule_id = EXCLUDED.schedule_id, policy_id = EXCLUDED.policy_id,
          result = EXCLUDED.result, active = TRUE, updated_at = NOW() RETURNING id`,
        [randomUUID(), first.subjectId, first.employeeId, first.employeeId ? null : first.deviceUserId, group.date, group.branch?.id ?? null,
          schedule?.id ?? null, policy?.id ?? null, JSON.stringify(result)])).rows[0];
        evaluations.push({ id: evaluation.id, subjectId: first.subjectId, date: group.date });
        for (const incident of daily.incidents) {
          const stored = (await client.query<{ id: string }>(`INSERT INTO attendance_incidents
            (id, evaluation_id, subject_id, policy_id, log_id, kind, occurred_at, minutes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (evaluation_id, kind) DO UPDATE SET policy_id = EXCLUDED.policy_id, log_id = EXCLUDED.log_id,
            occurred_at = EXCLUDED.occurred_at, minutes = EXCLUDED.minutes, active = TRUE RETURNING id`,
          [randomUUID(), evaluation.id, first.subjectId, policy!.id, incident.logId, incident.kind, incident.occurredAt, incident.minutes])).rows[0];
          activeIncidentIds.push(stored.id);
          const subjectIncidents = incidentsBySubject.get(first.subjectId) ?? [];
          subjectIncidents.push({ id: stored.id, policyId: policy!.id, kind: incident.kind, occurredAt: incident.occurredAt, date: group.date, settings: policy!.settings });
          incidentsBySubject.set(first.subjectId, subjectIncidents);
        }
      }
      await client.query('UPDATE attendance_incidents SET active = FALSE WHERE active AND NOT (id = ANY($1::uuid[]))', [activeIncidentIds]);
      const activeDeductionIds: string[] = [];
      for (const [subjectId, incidents] of incidentsBySubject) {
        const accumulated = accumulateIncidents(incidents, '9999-12-31');
        for (const deduction of accumulated.deductions) {
          const stored = (await client.query<{ id: string }>(`INSERT INTO attendance_deductions
            (id, subject_id, policy_id, trigger_incident_id, category, window_start, window_end, incident_ids)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (trigger_incident_id) DO UPDATE SET
            policy_id = EXCLUDED.policy_id, category = EXCLUDED.category, window_start = EXCLUDED.window_start,
            window_end = EXCLUDED.window_end, incident_ids = EXCLUDED.incident_ids, voided_at = NULL RETURNING id`,
          [randomUUID(), subjectId, deduction.policyId, deduction.triggerIncidentId, deduction.category, deduction.windowStart, deduction.windowEnd, deduction.incidentIds])).rows[0];
          activeDeductionIds.push(stored.id);
        }
      }
      await client.query('UPDATE attendance_deductions SET voided_at = NOW() WHERE voided_at IS NULL AND NOT (id = ANY($1::uuid[]))', [activeDeductionIds]);
      for (const evaluation of evaluations) {
        const incidents = incidentsBySubject.get(evaluation.subjectId) ?? [];
        const counted = accumulateIncidents(incidents, evaluation.date);
        const deductionDays = counted.deductions.filter((deduction) => incidents.find((incident) => incident.id === deduction.triggerIncidentId)?.date === evaluation.date).length;
        await client.query(`UPDATE attendance_evaluations SET result = result || $2::jsonb WHERE id = $1`,
          [evaluation.id, JSON.stringify({ counters: counted.remaining, deductionDays })]);
      }
      // Los vínculos corregidos pueden dejar evaluaciones de una identidad anterior.
      await client.query('UPDATE attendance_evaluations SET active = FALSE WHERE NOT (id = ANY($1::uuid[]))', [evaluations.map((evaluation) => evaluation.id)]);
      return { evaluatedDays: evaluations.length, deductions: activeDeductionIds.length };
    });
  }

  async report(filters: { from: string; to: string; branchId?: string; subjectId?: string }) {
    return (await this.database.query(`SELECT id, subject_id AS "subjectId", employee_id AS "employeeId", device_user_id AS "deviceUserId",
      date::text, branch_id AS "branchId", result FROM attendance_evaluations WHERE active AND date BETWEEN $1::date AND $2::date
      AND ($3::uuid IS NULL OR branch_id = $3) AND ($4::uuid IS NULL OR subject_id = $4) ORDER BY date DESC, result ->> 'name'`,
    [filters.from, filters.to, filters.branchId ?? null, filters.subjectId ?? null])).rows;
  }

  async deductions(filters: { from: string; to: string; branchId?: string; subjectId?: string }) {
    return (await this.database.query(`SELECT d.id, d.subject_id AS "subjectId", d.category, d.salary_days AS "salaryDays",
      d.window_start::text AS "windowStart", d.window_end::text AS "windowEnd", d.incident_ids AS "incidentIds", d.voided_at AS "voidedAt",
      i.occurred_at AS "occurredAt", ev.result ->> 'name' AS name, ev.result ->> 'branchName' AS "branchName",
      ev.result ->> 'timeZone' AS "timeZone"
      FROM attendance_deductions d JOIN attendance_incidents i ON i.id = d.trigger_incident_id
      JOIN attendance_evaluations ev ON ev.id = i.evaluation_id WHERE ev.date BETWEEN $1::date AND $2::date
      AND ($3::uuid IS NULL OR ev.branch_id = $3) AND ($4::uuid IS NULL OR d.subject_id = $4) ORDER BY i.occurred_at DESC`,
    [filters.from, filters.to, filters.branchId ?? null, filters.subjectId ?? null])).rows;
  }
}
