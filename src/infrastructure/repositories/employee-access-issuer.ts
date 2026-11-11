import { randomUUID } from 'node:crypto';
import type { EmployeeAccessDelivery, EmployeeAccessIssuer } from '../../domain/use-cases/issue-employee-access.js';
import type { AuthPrincipal } from '../../domain/entities/auth.js';
import { AppError, ConfigurationError } from '../../domain/errors/app-error.js';
import type { Database } from '../database/database.js';
import type { EmailSettings } from '../config/email.js';
import { enqueueEmail } from './email-outbox.js';

export class PrismaEmployeeAccessIssuer implements EmployeeAccessIssuer {
  constructor(private readonly database: Database, private readonly settings: EmailSettings) {}
  issue(employeeId: string, username: string, password: string, passwordHash: string, actor: AuthPrincipal, delivery: EmployeeAccessDelivery['delivery']) {
    const sendEmail = delivery === 'email';
    if (sendEmail && !this.settings.encryptionKey) throw new ConfigurationError('Configura el correo y EMAIL_ENCRYPTION_KEY para enviar el acceso, o elige entrega manual.');
    return this.database.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('auth-account-management'))::text");
      const employee = (await client.query<{ name: string; email: string | null }>(`SELECT e.name,c.email FROM employees e LEFT JOIN employee_contacts c ON c.employee_id=e.id
        WHERE e.id=$1 AND e.is_active AND e.identification_status='confirmed' AND EXISTS(SELECT 1 FROM auth_accounts a WHERE a.id=$2 AND a.is_active AND
        (a.role='admin' OR (a.role='hr' AND EXISTS(SELECT 1 FROM auth_account_branches b WHERE b.account_id=a.id AND b.branch_id=e.branch_id)))) FOR UPDATE OF e`, [employeeId,actor.id])).rows[0];
      if (!employee) throw new AppError('El empleado no está disponible para tu cuenta.', 'FORBIDDEN');
      if (sendEmail && !employee.email) throw new ConfigurationError('Registra el correo del empleado antes de enviar el acceso, o elige entrega manual.');
      const current = (await client.query<{ id: string; role: string }>('SELECT id,role FROM auth_accounts WHERE employee_id=$1 FOR UPDATE', [employeeId])).rows[0];
      if (current && current.role !== 'employee') throw new ConfigurationError('Esta cuenta tiene privilegios adicionales. Adminístrala desde Cuentas de acceso.');
      const id = current?.id ?? randomUUID();
      const expiresAt = new Date(Date.now()+24*60*60*1000);
      if (current) await client.query(`UPDATE auth_accounts SET username=$2,password_hash=$3,must_change_password=TRUE,temporary_password_expires_at=$4,is_active=TRUE,version=version+1,updated_at=NOW() WHERE id=$1`, [id,username,passwordHash,expiresAt]);
      else await client.query(`INSERT INTO auth_accounts(id,username,name,password_hash,role,employee_id,temporary_password_expires_at)
        VALUES($1,$2,$3,$4,'employee',$5,$6)`, [id,username,employee.name,passwordHash,employeeId,expiresAt]);
      await client.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE account_id=$1 AND revoked_at IS NULL', [id]);
      const version = (await client.query<{ version: number }>('SELECT version FROM auth_accounts WHERE id=$1',[id])).rows[0].version;
      const emailId = sendEmail ? await enqueueEmail(client,this.settings,{ employeeId,recipient: employee.email!,kind: 'welcome',accountId: id,accountVersion: version,expiresAt,
        content: { subject: 'Tu acceso a Reloj Checador',text: `Hola ${employee.name},\n\nSe ha generado tu acceso al sistema.\n\nSistema: ${this.settings.publicUrl}\nUsuario: ${username}\nContraseña temporal: ${password}\n\nEsta contraseña vence en 24 horas. Al iniciar sesión deberás cambiarla.\n\nRecursos Humanos` } }) : null;
      await client.query(`INSERT INTO auth_audit_events(id,account_id,action,target_id,metadata) VALUES($1,$2,'employee_access_issued',$3,$4::jsonb)`, [randomUUID(),actor.id,id,JSON.stringify({ employeeId,emailId,delivery })]);
      return { username,emailId };
    });
  }
}
