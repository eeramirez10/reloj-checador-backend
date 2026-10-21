export interface BranchInput {
  name: string; street: string; exteriorNumber: string; interiorNumber: string; neighborhood: string;
  postalCode: string; city: string; state: string; country: string; phone: string; email: string;
  managerName: string; timeZone: string; active: boolean; notes: string;
}
export type Branch = BranchInput & { id: string };
export interface PolicySettings {
  entryToleranceMinutes: number; mealToleranceMinutes: number; entryAllowedTardies: number; mealAllowedTardies: number;
  accumulationMode: 'first_lateness' | 'calendar_month'; accumulationDays: number;
}
export interface BranchPolicy {
  id: string; branchId: string; effectiveFrom: string; settings: PolicySettings; createdAt?: Date;
}
export interface ScheduleSettings {
  workDays: number[]; entryTime: string; exitTime: string; mealEnabled: boolean;
  mealStart: string; mealEnd: string; mealDurationMinutes: number;
}
export interface WorkSchedule {
  id: string; branchId: string; name: string; effectiveFrom: string; isDefault: boolean;
  settings: ScheduleSettings; createdAt?: Date;
}
export interface AssignmentTargets { employeeIds: string[]; deviceUserIds: string[]; effectiveFrom: string }
export type OrganizationAssignment = AssignmentTargets & { deviceIds?: string[]; branchId?: string; scheduleId?: string | null };
