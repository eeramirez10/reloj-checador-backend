export type AccountRole = 'admin' | 'hr' | 'manager' | 'employee';
export interface AuthAccount {
  id: string; username: string; name: string; role: AccountRole; branchIds: string[];
  isActive: boolean; mustChangePassword: boolean; version: number; employeeId?: string | null; temporaryPasswordExpiresAt?: Date | null;
}
export interface AuthPrincipal extends AuthAccount { sessionHash: string; csrfToken: string; }
export interface AccountInput {
  username: string; name: string; role: AccountRole; branchIds: string[]; isActive: boolean; employeeId?: string | null;
}
export type AccessResource = 'employee' | 'device' | 'clockRecord' | 'branch' | 'schedule' | 'leave';
export function canAccessBranch(account: Pick<AuthAccount,'role'|'branchIds'>, branchId: string | null | undefined): boolean {
  return account.role === 'admin' || Boolean(branchId && account.branchIds.includes(branchId));
}
