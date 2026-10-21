import type { UserProfilePatch } from '../entities/personal-profile.js';

export type EmployeeCreation = UserProfilePatch & { branchId: string; position?: string | null };
export type EmployeeIdentification = UserProfilePatch & { targetEmployeeId?: string; useAsAssignedClock?: boolean };
export interface RegistryEmployee {
  id: string; branchId: string | null; identificationStatus: string; firstName: string | null;
}
export interface ClockBinding {
  id: string; employeeId: string; deviceId: string; branchId: string | null; bindingStatus: string;
}
export interface EmployeeHistory {
  snapshots: Record<string, any>[]; merges: Record<string, any>[];
  clockEvents: Record<string, any>[]; statusEvents: Record<string, any>[];
}
export interface EmployeeRegistrySession {
  branchTimeZone(id: string): Promise<string | undefined>;
  create(input: EmployeeCreation, name: string, hireDate: string): Promise<string>;
  lockEmployee(id: string): Promise<RegistryEmployee>;
  updateProfile(id: string, fields: Record<string, string | null>): Promise<void>;
  confirm(id: string): Promise<void>;
  listClocks(employeeId: string): Promise<ClockBinding[]>;
  currentClock(employeeId: string): Promise<ClockBinding | undefined>;
  findClock(id: string): Promise<ClockBinding | undefined>;
  archiveAndMerge(sourceId: string, targetId: string): Promise<void>;
  assignClock(employeeId: string, clockId: string, previousId: string | undefined, reason: 'assignment' | 'identification'): Promise<void>;
  finishMerge(sourceId: string, targetId: string): Promise<void>;
}
export interface EmployeeRegistryRepository {
  transaction<T>(operation: (session: EmployeeRegistrySession) => Promise<T>): Promise<T>;
  clockEmployeeId(id: string): Promise<string | undefined>;
  history(employeeId: string): Promise<EmployeeHistory>;
}
