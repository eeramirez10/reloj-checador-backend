import type { AuthPrincipal } from '../entities/auth.js';
import type { PasswordHasher } from '../repositories/auth-repository.js';
import { AppError } from '../errors/app-error.js';

export interface EmployeeAccessIssuer {
  issue(employeeId: string, username: string, password: string, passwordHash: string, actor: AuthPrincipal): Promise<{ username: string; emailId: string }>;
}
export class IssueEmployeeAccess {
  constructor(private readonly issuer: EmployeeAccessIssuer, private readonly hasher: PasswordHasher, private readonly password: () => string) {}
  async execute(employeeId: string, username: string, actor: AuthPrincipal) {
    if (!['admin','hr'].includes(actor.role)) throw new AppError('Solo RH o administrador pueden generar accesos.', 'FORBIDDEN');
    const password = this.password();
    return this.issuer.issue(employeeId,username,password,await this.hasher.hash(password),actor);
  }
}
