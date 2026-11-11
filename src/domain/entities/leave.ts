export type LeaveKind = 'absence' | 'late_arrival' | 'early_exit';
export type LeaveStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export interface LeaveInput {
  employeeId: string; kind: LeaveKind; from: string; to: string; authorizedTime: string | null;
  paid: boolean; useVacation: boolean; reason: string;
}
export interface LeaveDay {
  date: string; branchId: string; branchName: string; timeZone: string;
  scheduledEntry: string; scheduledExit: string; start: string; end: string;
}
export interface LeaveDetails { employeeName: string; employeeNumber: string | null; managerName: string; branchName: string; days: LeaveDay[] }
export interface LeaveRequest extends LeaveInput {
  id: string; managerId: string; branchId: string; status: LeaveStatus; details: LeaveDetails;
  source: 'web' | 'whatsapp'; version: number; createdAt: string; resolvedAt: string | null; resolvedBy: string | null;
}
export interface LeaveProfile {
  employeeId: string; managerId: string | null; managerName: string | null; whatsappPhone: string | null;
  vacationBalance: number; version: number;
}
export interface LeaveProfileInput {
  managerId: string | null; whatsappPhone: string | null; vacationBalance: number; expectedVersion: number; adjustmentReason: string;
}
export interface VacationMovement { id: string; requestId: string | null; kind: 'adjustment' | 'consumption' | 'return'; days: number; balanceAfter: number; reason: string; createdAt: string }
export interface LeaveEvent {
  emailStatus?: string | null; recipientEmail?: string | null;
  actorAccountId?: string | null; actorAccountName?: string | null;
  id: string; kind: 'created' | Exclude<LeaveStatus, 'pending'>; actorEmployeeId: string | null; comments: string;
  recipientEmployeeId: string; recipientPhone: string | null; notificationStatus: 'awaiting_configuration'; createdAt: string;
}
export interface LeavePreview { input: LeaveInput; managerId: string; details: LeaveDetails; vacationBalance: number; vacationDays: number; token: string }
export interface LeaveFilters { from: string; to: string; branchId?: string; employeeId?: string; managerId?: string; status?: LeaveStatus; kind?: LeaveKind; scope?: 'own' | 'assigned'; page: number; limit: number }
export interface LeaveAuthorization {
  requestId: string; kind: LeaveKind; paid: boolean; useVacation: boolean; reason: string; authorizedTime: string | null;
  start: string; end: string;
}
