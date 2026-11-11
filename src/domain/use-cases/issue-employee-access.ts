import type { AuthPrincipal } from '../entities/auth.js';
import type { PasswordHasher } from '../repositories/auth-repository.js';
import { AppError, ConfigurationError } from '../errors/app-error.js';

export type EmployeeAccessDelivery = { delivery: 'manual'; password: string } | { delivery: 'email' };

export interface EmployeeAccessIssuer {
  issue(employeeId: string, username: string, password: string, passwordHash: string, actor: AuthPrincipal, delivery: EmployeeAccessDelivery['delivery']): Promise<{ username: string; emailId: string | null }>;
}
export class IssueEmployeeAccess {
  constructor(private readonly issuer: EmployeeAccessIssuer, private readonly hasher: PasswordHasher, private readonly password: () => string) {}
  async execute(employeeId: string, username: string, actor: AuthPrincipal, options: EmployeeAccessDelivery = { delivery: 'email' }) {
    if (!['admin','hr'].includes(actor.role)) throw new AppError('Solo RH o administrador pueden generar accesos.', 'FORBIDDEN');
    const password = options.delivery === 'manual' ? options.password : this.password();
    if (password.length < 8 || password.length > 128) throw new ConfigurationError('Usa una contraseña temporal de 8 a 128 caracteres.');
    return this.issuer.issue(employeeId,username,password,await this.hasher.hash(password),actor,options.delivery);
  }
}
