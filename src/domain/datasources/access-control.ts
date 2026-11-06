import type { AccessResource, AuthPrincipal } from '../entities/auth.js';
export interface AccessControl {
  run<T>(callback: () => T): T;
  set(principal: AuthPrincipal): void;
  current(): AuthPrincipal | undefined;
  assertResource(kind: AccessResource, id: string): Promise<void>;
  assertEmployeeHistory(id: string): Promise<void>;
}
