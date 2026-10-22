import type { Branch, BranchMealSettings, BranchPolicy, PolicySettings, WorkSchedule } from './organization.js';
import type { WorkHours } from './employee-scheduling.js';
import { effectiveVersion } from './employee-scheduling.js';

export interface BranchConfigurationInput {
  effectiveFrom: string; workHours: WorkHours; meal: BranchMealSettings;
  recognitionMarginMinutes: number; policy: PolicySettings; expectedVersionId?: string | null;
}
export interface BranchConfigurationContext {
  branch: Pick<Branch, 'id' | 'name' | 'timeZone'>; date: string; firstAttendanceDate: string | null;
  schedules: WorkSchedule[]; policies: BranchPolicy[];
}
export interface BranchConfigurationVersion {
  id: string; kind: 'configuration' | 'schedule' | 'policy'; effectiveFrom: string;
  createdAt: Date; deletedAt: Date | null; schedule?: WorkSchedule; policy?: BranchPolicy;
}

export function configurationHistory(context: BranchConfigurationContext): BranchConfigurationVersion[] {
  const versions = new Map<string, BranchConfigurationVersion>();
  for (const schedule of context.schedules) {
    const id = schedule.configurationId ?? schedule.id;
    versions.set(id, { id, kind: schedule.configurationId ? 'configuration' : 'schedule', effectiveFrom: schedule.effectiveFrom,
      createdAt: schedule.createdAt!, deletedAt: schedule.deletedAt ?? null, schedule });
  }
  for (const policy of context.policies) {
    const id = policy.configurationId ?? policy.id;
    const version = versions.get(id) ?? { id, kind: policy.configurationId ? 'configuration' : 'policy', effectiveFrom: policy.effectiveFrom,
      createdAt: policy.createdAt!, deletedAt: policy.deletedAt ?? null };
    version.policy = policy;
    versions.set(id, version);
  }
  return [...versions.values()].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id));
}

export function configurationToken(context: BranchConfigurationContext): string | null {
  const latest = configurationHistory(context).sort((left, right) =>
    (right.deletedAt ?? right.createdAt).getTime() - (left.deletedAt ?? left.createdAt).getTime() || right.id.localeCompare(left.id))[0];
  return latest ? `${latest.id}:${(latest.deletedAt ?? latest.createdAt).toISOString()}` : null;
}

export function configurationView(context: BranchConfigurationContext) {
  return { branch: context.branch, date: context.date, firstAttendanceDate: context.firstAttendanceDate,
    schedule: effectiveVersion(context.schedules.filter((item) => item.isDefault), context.date) ?? null,
    policy: effectiveVersion(context.policies, context.date) ?? null,
    latestVersionId: configurationToken(context), history: configurationHistory(context) };
}
