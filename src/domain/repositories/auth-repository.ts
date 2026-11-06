import type { AccountInput, AuthAccount, AuthPrincipal } from '../entities/auth.js';

export interface AuthRepository {
  credentials(username: string): Promise<(AuthAccount & { passwordHash: string }) | undefined>;
  session(tokenHash: string): Promise<AuthPrincipal | undefined>;
  createSession(tokenHash: string, csrfToken: string, accountId: string, expiresAt: Date, expectedVersion: number): Promise<void>;
  revoke(tokenHash: string): Promise<void>;
  list(): Promise<AuthAccount[]>;
  save(actorId: string | null, input: AccountInput, passwordHash?: string, id?: string, expectedVersion?: number): Promise<AuthAccount>;
  changePassword(accountId: string, passwordHash: string, currentHash: string, expectedVersion: number): Promise<void>;
  audit(accountId: string | null, action: string, targetId?: string, metadata?: object): Promise<void>;
  auditHistory(): Promise<unknown[]>;
}
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}
export interface AuthTokens { random(): string; hash(value: string): string; }
