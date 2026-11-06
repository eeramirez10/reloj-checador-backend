import type { Branch, BranchPolicy, WorkSchedule } from '../entities/organization.js';
import type { CalculatedDeduction, DailyEvaluation } from '../entities/schedule-evaluator.js';
import type { ReportFilters } from '../dtos/filters.js';
import type { LeaveRequest } from '../entities/leave.js';
import type { EmployeeScheduleVersion } from '../entities/employee-scheduling.js';

export interface SubjectLog {
  id: string; employeeId: string | null; deviceUserId: string; subjectId: string; name: string;
  employeeNumber: string | null; userId: string; branchId: string | null; occurredAt: Date;
}
export type EvaluationBranch = Pick<Branch, 'id' | 'name' | 'timeZone'>;
export interface EvaluationSnapshot {
  branches: EvaluationBranch[]; policies: BranchPolicy[]; schedules: WorkSchedule[]; logs: SubjectLog[];
  assignments: Array<{ employeeId: string | null; deviceUserId: string | null; scheduleId: string | null; effectiveFrom: string }>;
  branchAssignments: Array<{ targetId: string; branchId: string; effectiveFrom: string }>;
  employeeSchedules: EmployeeScheduleVersion[];
  approvedLeaves?: LeaveRequest[];
  leaveSubjects?: SubjectLog[];
}
export interface EvaluationWrite {
  subjectId: string; employeeId: string | null; deviceUserId: string | null; date: string;
  branchId: string | null; scheduleId: string | null; policyId: string | null; result: DailyEvaluation & Record<string, unknown>;
}
export interface EvaluationSession {
  snapshot(): Promise<EvaluationSnapshot>;
  saveEvaluation(input: EvaluationWrite): Promise<string>;
  saveIncident(evaluationId: string, subjectId: string, policyId: string, incident: DailyEvaluation['incidents'][number]): Promise<string>;
  saveDeduction(subjectId: string, deduction: CalculatedDeduction): Promise<string>;
  reconcile(activeIncidentIds: string[], activeDeductionIds: string[], activeEvaluationIds: string[]): Promise<void>;
  updateCounters(id: string, counters: { arrival: number; meal: number }, deductionDays: number): Promise<void>;
}
export interface EvaluationRepository {
  transaction<T>(operation: (session: EvaluationSession) => Promise<T>): Promise<T>;
  report(filters: ReportFilters): Promise<Record<string, any>[]>;
  deductions(filters: ReportFilters): Promise<Record<string, any>[]>;
}
