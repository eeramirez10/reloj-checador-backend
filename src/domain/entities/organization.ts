export interface BranchInput {
  name: string; street: string; exteriorNumber: string; interiorNumber: string; neighborhood: string;
  postalCode: string; city: string; state: string; country: string; phone: string; email: string;
  managerName: string; timeZone: string; active: boolean; notes: string;
}
export type Branch = BranchInput & { id: string };
export const DEFAULT_ENTRY_REPEAT_WINDOW_MINUTES = 20;
export interface PolicySettings {
  entryToleranceMinutes: number; mealToleranceMinutes: number; entryAllowedTardies: number; mealAllowedTardies: number;
  accumulationMode: 'first_lateness' | 'calendar_month'; accumulationDays: number;
  entryRepeatWindowMinutes?: number;
}
export interface BranchPolicy {
  id: string; branchId: string; effectiveFrom: string; settings: PolicySettings; createdAt?: Date;
  configurationId?: string | null; supersededFrom?: string | null; deletedAt?: Date | null;
}
export interface BranchMealSettings {
  mode: 'automatic' | 'configured' | 'disabled'; startTime: string; endTime: string; durationMinutes: number;
}
export interface ScheduleSettings {
  workDays: number[]; entryTime: string; exitTime: string; mealEnabled: boolean;
  mealStart: string; mealEnd: string; mealDurationMinutes: number;
  mealMode?: 'schedule' | 'individual'; recognitionMarginMinutes?: number; mealPending?: boolean;
  mealDetection?: 'automatic' | 'configured' | 'disabled' | 'invalid';
  branchMeal?: BranchMealSettings; mealSource?: 'branch' | 'individual' | 'automatic';
}
export interface WorkSchedule {
  id: string; branchId: string; name: string; effectiveFrom: string; isDefault: boolean;
  settings: ScheduleSettings; createdAt?: Date;
  supersededFrom?: string | null;
  configurationId?: string | null; deletedAt?: Date | null;
}
export interface AssignmentTargets { employeeIds: string[]; deviceUserIds: string[]; effectiveFrom: string }
export type OrganizationAssignment = AssignmentTargets & { deviceIds?: string[]; branchId?: string; scheduleId?: string | null };

export function workOnlyScheduleSettings(settings: ScheduleSettings): ScheduleSettings {
  return { workDays: settings.workDays, entryTime: settings.entryTime, exitTime: settings.exitTime,
    mealEnabled: false, mealStart: '00:00', mealEnd: '00:00', mealDurationMinutes: 60, mealMode: 'individual',
    recognitionMarginMinutes: settings.recognitionMarginMinutes ?? 30 };
}
