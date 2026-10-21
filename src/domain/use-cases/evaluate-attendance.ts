import type { EvaluationBranch, EvaluationRepository, SubjectLog } from '../repositories/evaluation-repository.js';
import type { ReportFilters } from '../dtos/filters.js';
import { formatDateTimeInTimeZone } from '../entities/attendance-summary.js';
import { accumulateIncidents, evaluateDay, type CountedIncident, type DailyEvaluation } from '../entities/schedule-evaluator.js';

function effective<T extends { effectiveFrom: string; createdAt?: Date }>(items: T[], date: string): T | undefined {
  return items.filter((item) => item.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)
    || (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
}

export class AttendanceEvaluationService {
  constructor(private readonly repository: EvaluationRepository) {}

  async recalculate(): Promise<{ evaluatedDays: number; deductions: number }> {
    return this.repository.transaction(async (session) => {
      const snapshot = await session.snapshot();
      const branches = new Map(snapshot.branches.map((branch) => [branch.id, branch]));
      const schedules = new Map(snapshot.schedules.map((schedule) => [schedule.id, schedule]));
      const groups = new Map<string, { date: string; branch?: EvaluationBranch; logs: SubjectLog[] }>();
      for (const log of snapshot.logs) {
        const history = snapshot.branchAssignments.filter((assignment) => assignment.targetId === log.subjectId);
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
        const policy = effective(snapshot.policies.filter((item) => item.branchId === group.branch?.id), group.date);
        const assignment = effective(snapshot.assignments.filter((item) => first.employeeId
          ? item.employeeId === first.employeeId : item.deviceUserId === first.deviceUserId), group.date);
        const assigned = assignment?.scheduleId ? schedules.get(assignment.scheduleId) : undefined;
        const schedule = assigned && assigned.effectiveFrom <= group.date ? assigned
          : effective(snapshot.schedules.filter((item) => item.branchId === group.branch?.id && item.isDefault), group.date);
        const zone = group.branch?.timeZone ?? 'America/Mexico_City';
        const daily: DailyEvaluation = policy && schedule ? evaluateDay(group.date, group.logs, schedule.settings, policy.settings, zone)
          : { date: group.date, status: 'unconfigured', punches: group.logs.map((log) => ({ id: log.id, occurredAt: log.occurredAt.toISOString(), localTime: formatDateTimeInTimeZone(log.occurredAt, zone), movement: 'unclassified' })),
            issues: ['Asigna una sucursal, un horario y reglas vigentes para calcular esta jornada.'], incidents: [] };
        const result = { ...daily, name: first.name, employeeNumber: first.employeeNumber, userIds: [...new Set(group.logs.map((log) => log.userId))],
          branchName: group.branch?.name, scheduleName: schedule?.name, timeZone: zone, policy: policy?.settings };
        const evaluationId = await session.saveEvaluation({
          subjectId: first.subjectId, employeeId: first.employeeId, deviceUserId: first.employeeId ? null : first.deviceUserId,
          date: group.date, branchId: group.branch?.id ?? null, scheduleId: schedule?.id ?? null, policyId: policy?.id ?? null, result,
        });
        evaluations.push({ id: evaluationId, subjectId: first.subjectId, date: group.date });
        for (const incident of daily.incidents) {
          const incidentId = await session.saveIncident(evaluationId, first.subjectId, policy!.id, incident);
          activeIncidentIds.push(incidentId);
          const subjectIncidents = incidentsBySubject.get(first.subjectId) ?? [];
          subjectIncidents.push({ id: incidentId, policyId: policy!.id, kind: incident.kind, occurredAt: incident.occurredAt, date: group.date, settings: policy!.settings });
          incidentsBySubject.set(first.subjectId, subjectIncidents);
        }
      }
      const activeDeductionIds: string[] = [];
      for (const [subjectId, incidents] of incidentsBySubject) {
        const accumulated = accumulateIncidents(incidents, '9999-12-31');
        for (const deduction of accumulated.deductions) {
          activeDeductionIds.push(await session.saveDeduction(subjectId, deduction));
        }
      }
      for (const evaluation of evaluations) {
        const incidents = incidentsBySubject.get(evaluation.subjectId) ?? [];
        const counted = accumulateIncidents(incidents, evaluation.date);
        const deductionDays = counted.deductions.filter((deduction) => incidents.find((incident) => incident.id === deduction.triggerIncidentId)?.date === evaluation.date).length;
        await session.updateCounters(evaluation.id, counted.remaining, deductionDays);
      }
      await session.reconcile(activeIncidentIds, activeDeductionIds, evaluations.map((evaluation) => evaluation.id));
      return { evaluatedDays: evaluations.length, deductions: activeDeductionIds.length };
    });
  }

  report(filters: ReportFilters) {
    return this.repository.report(filters);
  }

  deductions(filters: ReportFilters) {
    return this.repository.deductions(filters);
  }
}
