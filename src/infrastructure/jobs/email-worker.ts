import { randomUUID } from 'node:crypto';
import type { Database } from '../database/database.js';
import { EmailSendError, type EmailGateway } from '../../domain/datasources/email-gateway.js';
import { EmailContentCipher } from '../integrations/email-content-cipher.js';

interface PendingEmail { id: string; recipient: string; encryptedContent: string; attempts: number; leaseToken: string }
export class EmailWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly cipher: EmailContentCipher;
  constructor(private readonly database: Database, private readonly gateway: EmailGateway, key: string, private readonly reportError: () => void = () => console.error('No se pudo procesar la cola de correo.')) { this.cipher = new EmailContentCipher(key); }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(this.reportError); },2000);
    this.timer.unref();
  }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.running; }
  tick() {
    if (this.running) return this.running;
    this.running = this.process().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async claim(): Promise<PendingEmail | undefined> {
    return this.database.transaction(async client => {
      await client.query(`UPDATE email_outbox SET state='uncertain',error_code='SEND_INTERRUPTED',lease_until=NULL,lease_token=NULL
        WHERE state='sending' AND lease_until<NOW()`);
      await client.query(`UPDATE email_outbox m SET state='expired',encrypted_content=NULL,completed_at=NOW(),lease_token=NULL,lease_until=NULL
        WHERE state IN ('pending','uncertain','failed') AND (expires_at<=NOW()
        OR NOT EXISTS(SELECT 1 FROM employees e JOIN employee_contacts c ON c.employee_id=e.id WHERE e.id=m.employee_id AND e.is_active AND e.identification_status='confirmed' AND lower(c.email)=lower(m.recipient))
        OR (kind='welcome' AND NOT EXISTS(SELECT 1 FROM auth_accounts a WHERE a.id=m.account_id AND a.version=m.account_version AND a.is_active AND a.must_change_password AND a.employee_id=m.employee_id)))`);
      const row = (await client.query<Omit<PendingEmail,'leaseToken'>>(`SELECT id,recipient,encrypted_content AS "encryptedContent",attempts FROM email_outbox
        WHERE state='pending' AND next_attempt_at<=NOW() ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!row) return;
      const leaseToken = randomUUID();
      await client.query(`UPDATE email_outbox SET state='sending',attempts=attempts+1,lease_token=$2,lease_until=NOW()+INTERVAL '2 minutes' WHERE id=$1`,[row.id,leaseToken]);
      return { ...row,attempts: row.attempts+1,leaseToken };
    });
  }
  private async process() {
    const message = await this.claim();
    if (!message) return;
    try {
      const content = this.cipher.decrypt(message.encryptedContent,message.id);
      await this.gateway.send(message.recipient,content);
      await this.database.query(`UPDATE email_outbox SET state='accepted',encrypted_content=NULL,completed_at=NOW(),lease_token=NULL,lease_until=NULL,error_code=NULL
        WHERE id=$1 AND state='sending' AND lease_token=$2`,[message.id,message.leaseToken]);
    } catch (error) {
      const failure = error instanceof EmailSendError ? error : new EmailSendError('uncertain','SEND_UNCONFIRMED');
      const state = failure.kind === 'uncertain' ? 'uncertain' : failure.kind === 'retryable' && message.attempts < 5 ? 'pending' : 'failed';
      const seconds = Math.max(failure.retryAfterSeconds,Math.min(3600,30*2**message.attempts));
      await this.database.query(`UPDATE email_outbox SET state=$3,error_code=$4,next_attempt_at=NOW()+$5*INTERVAL '1 second',
        encrypted_content=CASE WHEN $3='failed' THEN NULL ELSE encrypted_content END,lease_token=NULL,lease_until=NULL
        WHERE id=$1 AND state='sending' AND lease_token=$2`, [message.id,message.leaseToken,state,failure.code,seconds]);
    }
  }
}
