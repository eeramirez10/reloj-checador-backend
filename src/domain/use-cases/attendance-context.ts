import { formatDateTimeInTimeZone } from '../entities/attendance-summary.js';
import { effectiveVersion, resolveEmployeeSchedule, type EmployeeScheduleVersion, type ResolvedEmployeeSchedule } from '../entities/employee-scheduling.js';
import { DEFAULT_OVERTIME_SETTINGS, type OvertimeSettings } from '../entities/overtime.js';
import type { BranchPolicy, WorkSchedule } from '../entities/organization.js';
import type { DailyEvaluation } from '../entities/schedule-evaluator.js';
import type { EvaluationBranch, EvaluationSnapshot, SubjectLog } from '../repositories/evaluation-repository.js';

export interface AttendanceContext {
  date: string; branch?: EvaluationBranch; base?: WorkSchedule; policy?: BranchPolicy;
  version?: EmployeeScheduleVersion; schedule?: ResolvedEmployeeSchedule; overtime: OvertimeSettings;
}
export interface EvaluatedAttendanceDay extends AttendanceContext {
  subject: SubjectLog; logs: SubjectLog[]; daily: DailyEvaluation;
}

export class SubjectAttendanceContext {
  private readonly branches;
  private readonly versions;
  private readonly assignments;
  private readonly branchHistory;
  constructor(private readonly snapshot: EvaluationSnapshot, private readonly subject: SubjectLog) {
    this.branches = new Map(snapshot.branches.map((item) => [item.id,item]));
    this.versions = snapshot.employeeSchedules.filter((item) => item.employeeId === subject.subjectId);
    this.assignments = snapshot.assignments.filter((item) => subject.employeeId ? item.employeeId === subject.employeeId : item.deviceUserId === subject.deviceUserId);
    this.branchHistory = snapshot.branchAssignments.filter((item) => item.targetId === subject.subjectId);
  }
  locate(log: SubjectLog): AttendanceContext {
    const assignment = this.branchHistory.filter((item) => item.effectiveFrom <= formatDateTimeInTimeZone(log.occurredAt,
      this.branches.get(item.branchId)?.timeZone ?? 'America/Mexico_City').slice(0,10))
      .sort((a,b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    const branch = this.branches.get((this.branchHistory.length ? assignment?.branchId : log.branchId) ?? '');
    const date = formatDateTimeInTimeZone(log.occurredAt,branch?.timeZone ?? 'America/Mexico_City').slice(0,10);
    return this.at(date,branch);
  }
  branchAt(date: string, fallback?: EvaluationBranch): EvaluationBranch | undefined {
    return this.branchHistory.length ? this.branches.get(effectiveVersion(this.branchHistory,date)?.branchId ?? '') : fallback;
  }
  latestLocalDate(instant: Date): string {
    return [...this.branches.values()].map((branch) => formatDateTimeInTimeZone(instant,branch.timeZone).slice(0,10))
      .concat(formatDateTimeInTimeZone(instant,'America/Mexico_City').slice(0,10)).sort().at(-1)!;
  }
  at(date: string, branch?: EvaluationBranch, forceBranch = false): AttendanceContext {
    const base = effectiveVersion(this.snapshot.schedules.filter((item) => item.branchId === branch?.id && item.isDefault),date);
    const policy = effectiveVersion(this.snapshot.policies.filter((item) => item.branchId === branch?.id),date);
    const version = effectiveVersion(this.versions,date);
    const overtime = version?.overtime ?? DEFAULT_OVERTIME_SETTINGS;
    const assignment = effectiveVersion(this.assignments,date);
    const assigned = this.snapshot.schedules.find((item) => item.id === assignment?.scheduleId && item.effectiveFrom <= date);
    const route = overtime.enabled && overtime.workMode === 'route';
    const useBranch = forceBranch || overtime.enabled;
    const schedule = useBranch ? base ? resolveEmployeeSchedule(base,undefined,version ? { ...version, workHours: null } : undefined) : undefined
      : resolveEmployeeSchedule(base,assigned,version);
    if (schedule && (forceBranch || route)) schedule.settings = { ...schedule.settings, mealEnabled: false, mealPending: false, mealDetection: 'disabled' };
    return { date, branch, base, policy, version, schedule, overtime };
  }
}
