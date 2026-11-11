import type { LeaveEvent, LeaveFilters, LeaveInput, LeaveDetails, LeaveProfile, LeaveProfileInput, LeaveRequest, LeaveStatus, VacationMovement } from '../entities/leave.js';
import type { Employee } from '../entities/employee.js';
import type { EmployeeAttendanceHistory } from './employee-attendance-repository.js';
import type { AuthAccount,AuthPrincipal } from '../entities/auth.js';

export interface LeaveContext { employee: Employee; profile: LeaveProfile; history: EmployeeAttendanceHistory }

export interface LeaveSession {
  decisionAccount(id: string): Promise<Pick<AuthAccount,'role' | 'employeeId' | 'isActive' | 'version'> | undefined>;
  cancellationBranches(id:string):Promise<Array<string|null>>;
  context(employeeId: string, from: string, to: string): Promise<LeaveContext>;
  profile(employeeId: string): Promise<LeaveProfile>;
  saveProfile(employeeId: string, input: LeaveProfileInput): Promise<LeaveProfile>;
  vacationMovement(employeeId: string, days: number, kind: VacationMovement['kind'], reason: string, requestId?: string): Promise<void>;
  find(id: string): Promise<LeaveRequest>;
  overlapping(employeeId: string, from: string, to: string): Promise<LeaveRequest[]>;
  create(input: LeaveInput, managerId: string, branchId: string, details: LeaveDetails, sourceKey: string): Promise<LeaveRequest>;
  findBySourceKey(key: string): Promise<LeaveRequest | null>;
  resolve(id: string, status: LeaveStatus, actorId: string|null): Promise<LeaveRequest>;
  event(request: LeaveRequest, kind: LeaveEvent['kind'], comments: string, actorId?: string|null,previousStatus?:LeaveStatus,actorAccount?:AuthPrincipal): Promise<void>;
  recalculateAttendance(): Promise<void>;
}
export interface LeaveRepository {
  transaction<T>(operation: (session: LeaveSession) => Promise<T>): Promise<T>;
  list(filters: LeaveFilters): Promise<{ requests: LeaveRequest[]; total: number; page: number; limit: number }>;
  detail(id: string): Promise<{ request: LeaveRequest; events: LeaveEvent[] }>;
  profile(employeeId: string): Promise<LeaveProfile & { movements: VacationMovement[] }>;
}
