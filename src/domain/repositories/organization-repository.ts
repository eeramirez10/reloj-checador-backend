import type { AssignmentTargets, Branch, BranchInput, BranchPolicy, OrganizationAssignment, WorkSchedule } from '../entities/organization.js';

export interface ScheduleAssignment {
  id: string; employeeId: string | null; deviceUserId: string | null; scheduleId: string | null; effectiveFrom: string;
}
export interface OrganizationRepository {
  refreshCurrentBranches(): Promise<void>;
  listBranches(): Promise<Branch[]>;
  saveBranch(input: BranchInput, id?: string): Promise<Branch | undefined>;
  listPolicies(): Promise<BranchPolicy[]>;
  addPolicy(branchId: string, input: Omit<BranchPolicy, 'id' | 'branchId'>): Promise<BranchPolicy>;
  listSchedules(): Promise<WorkSchedule[]>;
  addSchedule(input: Omit<WorkSchedule, 'id'>): Promise<WorkSchedule>;
  listAssignments(): Promise<ScheduleAssignment[]>;
  assignSchedule(scheduleId: string, targets: AssignmentTargets): Promise<void>;
  assignBranch(branchId: string, targets: AssignmentTargets & { deviceIds?: string[] }): Promise<void>;
  assign(input: OrganizationAssignment): Promise<void>;
}
