import { randomUUID } from 'node:crypto';
import type { AuthRepository } from '../../domain/repositories/auth-repository.js';
import type { AccountInput, AuthAccount, AuthPrincipal } from '../../domain/entities/auth.js';
import { AppError, ConfigurationError, ConflictError } from '../../domain/errors/app-error.js';
import type { Database, Queryable } from '../database/database.js';

const fields = `a.id,a.username,a.name,a.role,a.is_active AS "isActive",a.must_change_password AS "mustChangePassword",a.version,
  ARRAY(SELECT branch_id::text FROM auth_account_branches WHERE account_id=a.id ORDER BY branch_id) AS "branchIds"`;

async function audit(client: Queryable, accountId: string | null, action: string, targetId?: string, metadata: object = {}) {
  await client.query('INSERT INTO auth_audit_events(id,account_id,action,target_id,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
    [randomUUID(), accountId, action, targetId ?? null, JSON.stringify(metadata)]);
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly database: Database) {}

  async credentials(username: string) {
    return (await this.database.query<AuthAccount & { passwordHash: string }>(`SELECT ${fields},a.password_hash AS "passwordHash" FROM auth_accounts a WHERE username=$1`, [username])).rows[0];
  }
  async session(tokenHash: string) {
    return (await this.database.query<AuthPrincipal>(`SELECT ${fields},s.token_hash AS "sessionHash",s.csrf_token AS "csrfToken"
      FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>NOW() AND a.is_active`, [tokenHash])).rows[0];
  }
  async createSession(tokenHash: string, csrfToken: string, accountId: string, expiresAt: Date, expectedVersion: number) {
    await this.database.transaction(async client => {
      const account = (await client.query('SELECT id FROM auth_accounts WHERE id=$1 AND version=$2 AND is_active FOR UPDATE', [accountId, expectedVersion])).rows[0];
      if (!account) throw new AppError('La cuenta cambió. Vuelve a iniciar sesión.', 'UNAUTHORIZED');
      await client.query('DELETE FROM auth_sessions WHERE expires_at<NOW() OR revoked_at<NOW()-INTERVAL \'1 day\'');
      await client.query('INSERT INTO auth_sessions(token_hash,account_id,csrf_token,expires_at) VALUES($1,$2,$3,$4)', [tokenHash, accountId, csrfToken, expiresAt]);
      await audit(client, accountId, 'login');
    });
  }
  async revoke(tokenHash: string) {
    await this.database.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL', [tokenHash]);
  }
  async list() { return (await this.database.query<AuthAccount>(`SELECT ${fields} FROM auth_accounts a ORDER BY a.name,a.id`)).rows; }

  save(actorId: string | null, input: AccountInput, passwordHash?: string, id?: string, expectedVersion?: number): Promise<AuthAccount> {
    return this.database.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('auth-account-management'))::text");
      if (actorId !== null && !(await client.query("SELECT id FROM auth_accounts WHERE id=$1 AND role='admin' AND is_active FOR SHARE", [actorId])).rows.length) {
        throw new AppError('La cuenta administradora ya no tiene acceso.', 'FORBIDDEN');
      }
      if (actorId === null && (await client.query('SELECT id FROM auth_accounts LIMIT 1')).rows.length) throw new ConflictError('El administrador inicial ya fue creado. Usa el panel para crear otras cuentas.');
      const current = id ? (await client.query<AuthAccount>(`SELECT ${fields} FROM auth_accounts a WHERE a.id=$1 FOR UPDATE`, [id])).rows[0] : undefined;
      if (id && (!current || current.version !== expectedVersion)) throw new ConflictError('La cuenta cambió. Actualiza el listado.');
      if (actorId === id && (!input.isActive || input.role !== 'admin')) throw new ConfigurationError('No puedes desactivar ni quitar el rol administrador a tu propia cuenta.');
      if (current?.role === 'admin' && current.isActive && (!input.isActive || input.role !== 'admin')) {
        const others = (await client.query("SELECT id FROM auth_accounts WHERE role='admin' AND is_active AND id<>$1", [id])).rows;
        if (!others.length) throw new ConfigurationError('Debe permanecer al menos un administrador activo.');
      }
      const branches = (await client.query('SELECT id FROM branches WHERE id=ANY($1::uuid[])', [input.branchIds])).rows;
      if (branches.length !== input.branchIds.length) throw new ConfigurationError('Una sucursal seleccionada no existe.');
      const accountId = id ?? randomUUID();
      if (id) await client.query(`UPDATE auth_accounts SET username=$2,name=$3,role=$4,is_active=$5,password_hash=COALESCE($6,password_hash),
        must_change_password=CASE WHEN $6::text IS NULL THEN must_change_password ELSE TRUE END,version=version+1,updated_at=NOW() WHERE id=$1`,
      [id, input.username, input.name, input.role, input.isActive, passwordHash ?? null]);
      else await client.query('INSERT INTO auth_accounts(id,username,name,role,is_active,password_hash) VALUES($1,$2,$3,$4,$5,$6)',
        [accountId, input.username, input.name, input.role, input.isActive, passwordHash]);
      await client.query('DELETE FROM auth_account_branches WHERE account_id=$1', [accountId]);
      for (const branchId of input.branchIds) await client.query('INSERT INTO auth_account_branches(account_id,branch_id) VALUES($1,$2)', [accountId, branchId]);
      await client.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE account_id=$1 AND revoked_at IS NULL', [accountId]);
      await audit(client, actorId, id ? 'account_updated' : 'account_created', accountId, { role: input.role, branchIds: input.branchIds, isActive: input.isActive, passwordReset: Boolean(passwordHash) });
      return (await client.query<AuthAccount>(`SELECT ${fields} FROM auth_accounts a WHERE a.id=$1`, [accountId])).rows[0];
    });
  }

  async changePassword(accountId: string, passwordHash: string, currentHash: string, expectedVersion: number) {
    await this.database.transaction(async client => {
      const rows = (await client.query(`UPDATE auth_accounts SET password_hash=$2,must_change_password=FALSE,version=version+1,updated_at=NOW()
        WHERE id=$1 AND password_hash=$3 AND version=$4 AND is_active RETURNING id`, [accountId, passwordHash, currentHash, expectedVersion])).rows;
      if (!rows.length) throw new ConflictError('La cuenta cambió. Vuelve a iniciar sesión.');
      await client.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE account_id=$1 AND revoked_at IS NULL', [accountId]);
      await audit(client, accountId, 'password_changed', accountId);
    });
  }
  audit(accountId: string | null, action: string, targetId?: string, metadata?: object) { return audit(this.database, accountId, action, targetId, metadata); }
  async auditHistory() {
    return (await this.database.query(`SELECT e.id,e.account_id AS "accountId",a.username,e.action,e.target_id AS "targetId",e.metadata,e.created_at AS "createdAt"
      FROM auth_audit_events e LEFT JOIN auth_accounts a ON a.id=e.account_id ORDER BY e.created_at DESC,e.id DESC LIMIT 200`)).rows;
  }
}
