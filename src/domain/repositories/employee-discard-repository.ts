import type { AuthPrincipal } from '../entities/auth.js';
export interface EmployeeDiscardRepository {
  discard(employeeId: string,actor: AuthPrincipal,reason: string): Promise<void>;
}
