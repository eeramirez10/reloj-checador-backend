import type { AuthPrincipal } from './auth.js';
import type { LeaveRequest } from './leave.js';
import { AppError } from '../errors/app-error.js';

export function leaveCapabilities(account: AuthPrincipal, request: LeaveRequest) {
  const active = account.isActive && Boolean(account.employeeId);
  const assigned = active && account.employeeId === request.managerId && account.employeeId !== request.employeeId;
  const canDecide = assigned && ['employee','manager'].includes(account.role) && request.status === 'pending';
  return {
    canApprove: canDecide, canReject: canDecide,
    canCancel: active && [request.employeeId, request.managerId].includes(account.employeeId!) && ['pending','approved'].includes(request.status),
  };
}

export function assertLeaveDecision(account: AuthPrincipal, request: LeaveRequest, action: 'approve' | 'reject' | 'cancel') {
  const capabilities = leaveCapabilities(account, request);
  if (!(action === 'cancel' ? capabilities.canCancel : action === 'approve' ? capabilities.canApprove : capabilities.canReject)) {
    throw new AppError('Tu cuenta no está autorizada para realizar esta acción sobre la solicitud.', 'FORBIDDEN');
  }
  return account.employeeId!;
}
