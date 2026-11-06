import type { EvaluationRepository, EvaluationSession, SubjectLog } from '../repositories/evaluation-repository.js';
import type { ReportFilters } from '../dtos/filters.js';
import { accumulateIncidents, type CountedIncident } from '../entities/schedule-evaluator.js';
import { evaluateSubjectAttendance } from './evaluate-subject-attendance.js';

export class AttendanceEvaluationService {
  constructor(private readonly repository: EvaluationRepository) {}

  async recalculate(): Promise<{ evaluatedDays: number; deductions: number }> {
    return this.repository.transaction((session) => this.evaluate(session));
  }

  async evaluate(session: EvaluationSession): Promise<{ evaluatedDays: number; deductions: number }> {
      const snapshot = await session.snapshot();
      const subjects = new Map<string, SubjectLog[]>();
      for (const log of snapshot.logs) {
        const logs = subjects.get(log.subjectId) ?? [];
        logs.push(log); subjects.set(log.subjectId,logs);
      }
      for (const subject of snapshot.leaveSubjects ?? []) if (!subjects.has(subject.subjectId)) subjects.set(subject.subjectId, []);
      const activeIncidentIds: string[] = [];
      const incidentsBySubject = new Map<string, CountedIncident[]>();
      const evaluations: Array<{ id: string; subjectId: string; date: string }> = [];
      for (const [subjectId, logs] of subjects) for (const group of evaluateSubjectAttendance(logs,snapshot,new Date(),snapshot.leaveSubjects?.find((subject) => subject.subjectId === subjectId))) {
        const first = group.subject;
        const { policy, schedule, daily } = group;
        const zone = group.branch?.timeZone ?? 'America/Mexico_City';
        const result = { ...daily, name: first.name, employeeNumber: first.employeeNumber, userIds: [...new Set((group.logs.length ? group.logs.map((log) => log.userId) : [first.userId]).filter(Boolean))],
          branchName: group.branch?.name, scheduleName: schedule?.scheduleName, timeZone: zone, policy: policy?.settings,
          scheduleSource: schedule?.source, scheduleSettings: schedule?.settings, schedulingVersionId: schedule?.versionId,
          mealConfigured: schedule ? schedule.settings.mealDetection === 'configured' || schedule.settings.mealDetection === 'disabled' : false,
          mealDetection: schedule?.settings.mealDetection, policyConfigured: Boolean(policy) };
        const evaluationId = await session.saveEvaluation({
          subjectId: first.subjectId, employeeId: first.employeeId, deviceUserId: first.employeeId ? null : first.deviceUserId,
          date: group.date, branchId: group.branch?.id ?? null, scheduleId: schedule?.scheduleId ?? null, policyId: policy?.id ?? null, result,
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
  }

  report(filters: ReportFilters) {
    return this.repository.report(filters);
  }

  deductions(filters: ReportFilters) {
    return this.repository.deductions(filters);
  }
}
