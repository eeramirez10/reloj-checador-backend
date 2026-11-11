import { AppError, ConfigurationError } from '../errors/app-error.js';
import type { AuthRepository, AuthTokens, PasswordHasher } from '../repositories/auth-repository.js';
import type { AccountInput } from '../entities/auth.js';

export class ManageAuth {
  constructor(readonly repository: AuthRepository, private readonly passwords: PasswordHasher,
    readonly tokens: AuthTokens, private readonly sessionHours = 8) {}

  async login(username: string, password: string) {
    const account = await this.repository.credentials(username.toLowerCase());
    const valid = await this.passwords.verify(account?.passwordHash ?? '', password);
    if (!account?.isActive || !valid || (account.mustChangePassword && account.temporaryPasswordExpiresAt && new Date(account.temporaryPasswordExpiresAt).getTime() <= Date.now())) {
      await this.repository.audit(null, 'login_failed', account?.id, { username: username.toLowerCase() });
      throw new AppError('Usuario o contraseña incorrectos.', 'UNAUTHORIZED');
    }
    const token = this.tokens.random();
    await this.repository.createSession(this.tokens.hash(token), this.tokens.random(), account.id, new Date(Date.now() + this.sessionHours * 3600000), account.version);
    return token;
  }

  async save(actorId: string | null, input: AccountInput, password?: string, id?: string, expectedVersion?: number) {
    if (!['admin','employee'].includes(input.role) && !input.branchIds.length) throw new ConfigurationError('Asigna al menos una sucursal.');
    if (input.role === 'employee' && !input.employeeId) throw new ConfigurationError('Vincula la cuenta con un empleado.');
    if (!id && !password) throw new ConfigurationError('Indica una contraseña inicial.');
    return this.repository.save(actorId, { ...input, username: input.username.toLowerCase(), branchIds: ['admin','employee'].includes(input.role) ? [] : [...new Set(input.branchIds)] },
      password ? await this.passwords.hash(password) : undefined, id, expectedVersion);
  }

  async changePassword(accountId: string, currentPassword: string, newPassword: string) {
    const accounts = await this.repository.list();
    const account = accounts.find((item) => item.id === accountId);
    const credentials = account && await this.repository.credentials(account.username);
    if (!credentials || !await this.passwords.verify(credentials.passwordHash, currentPassword)) throw new ConfigurationError('La contraseña actual es incorrecta.');
    if (currentPassword === newPassword) throw new ConfigurationError('La nueva contraseña debe ser diferente.');
    await this.repository.changePassword(accountId, await this.passwords.hash(newPassword), credentials.passwordHash, account!.version);
  }
}
