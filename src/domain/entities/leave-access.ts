import type { AuthPrincipal } from './auth.js';
import type { LeaveRequest } from './leave.js';
import { AppError } from '../errors/app-error.js';
import { canAccessBranch } from './auth.js';

export function leaveCapabilities(account: AuthPrincipal, request: LeaveRequest) {
  const active = account.isActive && Boolean(account.employeeId);
  const assigned = active && account.employeeId === request.managerId && account.employeeId !== request.employeeId;
  const canDecide = assigned && ['employee','manager'].includes(account.role) && request.status === 'pending';
  const administrative = account.isActive && ['admin','hr'].includes(account.role)
    && [request.branchId,...request.details.days.map(day=>day.branchId)].every(branch=>canAccessBranch(account,branch));
  return {
    canApprove: canDecide, canReject: canDecide,
    canCancel: (administrative && ['pending','approved'].includes(request.status)) || (active && account.employeeId===request.employeeId && request.status==='pending'),
    canCorrect: request.status==='cancelled' && (administrative || active && account.employeeId===request.employeeId),
  };
}

export function assertLeaveDecision(account: AuthPrincipal, request: LeaveRequest, action: 'approve' | 'reject' | 'cancel') {
  const capabilities = leaveCapabilities(account, request);
  if (!(action === 'cancel' ? capabilities.canCancel : action === 'approve' ? capabilities.canApprove : capabilities.canReject)) {
    throw new AppError('Tu cuenta no está autorizada para realizar esta acción sobre la solicitud.', 'FORBIDDEN');
  }
  return account.employeeId ?? null;
}
