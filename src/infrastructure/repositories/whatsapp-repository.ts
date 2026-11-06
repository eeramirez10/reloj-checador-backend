import { randomUUID } from 'node:crypto';
import type { WhatsAppAttempt, WhatsAppContent, WhatsAppDelivery, WhatsAppInbound, WhatsAppInboxJob, WhatsAppMessage, WhatsAppReceipt, WhatsAppScope, WhatsAppSendFailure } from '../../domain/entities/whatsapp-message.js';
import type { WhatsAppRepository } from '../../domain/repositories/whatsapp-repository.js';
import { ConflictError } from '../../domain/errors/app-error.js';
import type { Database, Queryable } from '../database/database.js';
import { authorizedWhatsAppEmployee, enqueueWhatsApp, loadWhatsAppMessage, whatsappConversation } from '../datasources/whatsapp-store.js';
import { applyWhatsAppDelivery, recordWhatsAppDelivery } from '../datasources/whatsapp-delivery-store.js';

const leaseMilliseconds = 120_000;

export class PrismaWhatsAppRepository implements WhatsAppRepository {
  constructor(private readonly database: Database) {}
  resolveEmployee(phone: string) { return authorizedWhatsAppEmployee(this.database,phone); }

  private transaction<T>(scope: WhatsAppScope, operation: (client: Queryable) => Promise<T>) {
    return this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))::text', [`whatsapp:${scope.accountSid}:${scope.businessPhone}`]);
      return operation(client);
    });
  }

  receive(input: WhatsAppInbound, now: Date) {
    return this.transaction(input, async (client) => {
      const existing = (await client.query<{ id: string; employeeId: string | null }>('SELECT id,employee_id AS "employeeId" FROM whatsapp_messages WHERE account_sid=$1 AND provider_message_id=$2', [input.accountSid,input.providerMessageId])).rows[0];
      if (existing) return { id: existing.id, created: false, authorized: Boolean(existing.employeeId) };
      const employee = await authorizedWhatsAppEmployee(client,input.participantPhone);
      const conversationId = await whatsappConversation(client,input,input.participantPhone,employee?.id ?? null);
      await client.query('UPDATE whatsapp_conversations SET employee_id=$2,last_inbound_at=$3 WHERE id=$1', [conversationId,employee?.id ?? null,employee ? now : null]);
      const id = randomUUID();
      await client.query(`INSERT INTO whatsapp_messages (id,conversation_id,account_sid,employee_id,direction,content,attachments,state,provider_message_id,created_at,updated_at)
        VALUES ($1,$2,$3,$4,'inbound',$5::jsonb,$6::jsonb,$7,$8,$9,$9)`,
      [id,conversationId,input.accountSid,employee?.id ?? null,JSON.stringify({ kind: 'text', body: input.body }),JSON.stringify(input.attachments),employee ? 'received' : 'unauthorized',input.providerMessageId,now]);
      if (employee) await client.query('INSERT INTO whatsapp_inbox_jobs (id,message_id,next_attempt_at,created_at) VALUES ($1,$2,$3,$3)', [randomUUID(),id,now]);
      return { id, created: true, authorized: Boolean(employee) };
    });
  }

  enqueue(scope: WhatsAppScope, employeeId: string, content: WhatsAppContent, key: string, now: Date) {
    return this.transaction(scope, (client) => enqueueWhatsApp(client,scope,employeeId,content,key,now));
  }

  claimInbox(scope: WhatsAppScope, now: Date): Promise<WhatsAppInboxJob | null> {
    return this.transaction(scope, async (client) => {
      const row = (await client.query<{ id: string; messageId: string }>(`SELECT j.id,j.message_id AS "messageId" FROM whatsapp_inbox_jobs j
        JOIN whatsapp_messages m ON m.id=j.message_id JOIN whatsapp_conversations c ON c.id=m.conversation_id
        WHERE c.account_sid=$1 AND c.business_phone=$2 AND j.state='pending' AND j.next_attempt_at<=$3
        AND NOT EXISTS (SELECT 1 FROM whatsapp_inbox_jobs prior JOIN whatsapp_messages pm ON pm.id=prior.message_id
          WHERE pm.conversation_id=m.conversation_id AND prior.state IN ('pending','processing') AND pm.sequence<m.sequence)
        ORDER BY m.sequence FOR UPDATE OF j SKIP LOCKED LIMIT 1`, [scope.accountSid,scope.businessPhone,now])).rows[0];
      if (!row) return null;
      const token = randomUUID();
      await client.query("UPDATE whatsapp_inbox_jobs SET state='processing',attempts=attempts+1,lease_token=$2,lease_until=$3 WHERE id=$1", [row.id,token,new Date(now.getTime()+leaseMilliseconds)]);
      return { id: row.id, leaseToken: token, message: await loadWhatsAppMessage(client,row.messageId) };
    });
  }

  async finishInbox(job: WhatsAppInboxJob, state: 'completed' | 'blocked' | 'awaiting_handler', reply: WhatsAppContent | null, now: Date) {
    await this.transaction(job.message, async (client) => {
      const row = (await client.query("SELECT id FROM whatsapp_inbox_jobs WHERE id=$1 AND state='processing' AND lease_token=$2 AND lease_until>$3 FOR UPDATE", [job.id,job.leaseToken,now])).rows[0];
      if (!row) throw new ConflictError('La reserva del mensaje de WhatsApp venció.');
      const employee = await authorizedWhatsAppEmployee(client,job.message.participantPhone);
      const authorized = employee?.id === job.message.employeeId;
      if (reply && authorized) await enqueueWhatsApp(client,job.message,employee!.id,reply,`reply:${job.message.id}`,now);
      await client.query('UPDATE whatsapp_inbox_jobs SET state=$2,lease_token=NULL,lease_until=NULL,error_code=NULL,error_message=NULL WHERE id=$1', [job.id,authorized ? state : 'blocked']);
    });
  }

  async failInbox(job: WhatsAppInboxJob, now: Date) {
    await this.transaction(job.message, async (client) => {
      await client.query(`UPDATE whatsapp_inbox_jobs SET state=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,
        lease_token=NULL,lease_until=NULL,next_attempt_at=$3,error_code='HANDLER_FAILED',error_message='No se completó el procesamiento del mensaje.'
        WHERE id=$1 AND lease_token=$2 AND state='processing'`, [job.id,job.leaseToken,new Date(now.getTime()+30_000)]);
    });
  }

  claimOutbound(scope: WhatsAppScope, now: Date): Promise<WhatsAppAttempt | null> {
    return this.transaction(scope, async (client) => {
      const row = (await client.query<{ id: string; lastInboundAt: Date | null }>(`SELECT m.id,
        CASE WHEN c.employee_id=m.employee_id THEN c.last_inbound_at ELSE NULL END AS "lastInboundAt"
        FROM whatsapp_messages m JOIN whatsapp_conversations c ON c.id=m.conversation_id
        WHERE c.account_sid=$1 AND c.business_phone=$2 AND m.direction='outbound' AND m.state='pending' AND m.next_attempt_at<=$3
        AND NOT EXISTS (SELECT 1 FROM whatsapp_messages prior WHERE prior.conversation_id=m.conversation_id
          AND prior.direction='outbound' AND prior.state IN ('pending','sending','reconciliation') AND prior.sequence<m.sequence)
        ORDER BY m.sequence FOR UPDATE OF m SKIP LOCKED LIMIT 1`, [scope.accountSid,scope.businessPhone,now])).rows[0];
      if (!row) return null;
      const number = (await client.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM whatsapp_attempts WHERE message_id=$1', [row.id])).rows[0].count+1;
      const id = randomUUID();
      await client.query("UPDATE whatsapp_messages SET state='sending',updated_at=$2 WHERE id=$1", [row.id,now]);
      await client.query(`INSERT INTO whatsapp_attempts (id,message_id,number,state,lease_until,created_at) VALUES ($1,$2,$3,'sending',$4,$5)`, [id,row.id,number,new Date(now.getTime()+leaseMilliseconds),now]);
      return { id, number, lastInboundAt: row.lastInboundAt, message: await loadWhatsAppMessage(client,row.id) };
    });
  }

  async accept(attempt: WhatsAppAttempt, receipt: WhatsAppReceipt, now: Date) {
    await this.transaction(attempt.message, async (client) => {
      await recordWhatsAppDelivery(client,{ ...attempt.message, ...receipt, attemptId: attempt.id, eventKey: `api:${attempt.id}:${receipt.providerMessageId}:${receipt.providerStatus}` },now);
      const pending = (await client.query<{ id: string }>(`SELECT id FROM whatsapp_delivery_events WHERE account_sid=$1 AND provider_message_id=$2 AND attempt_id IS NULL ORDER BY created_at,id`, [attempt.message.accountSid,receipt.providerMessageId])).rows;
      for (const event of pending) await applyWhatsAppDelivery(client,event.id);
    });
  }

  async fail(attempt: WhatsAppAttempt, failure: WhatsAppSendFailure, now: Date) {
    await this.transaction(attempt.message, async (client) => {
      const row = (await client.query<{ state: string }>('SELECT state FROM whatsapp_attempts WHERE id=$1 FOR UPDATE', [attempt.id])).rows[0];
      if (row?.state !== 'sending') return;
      const retry = failure.kind === 'retryable' && attempt.number<3;
      const state = failure.kind === 'uncertain' ? 'reconciliation' : retry ? 'pending' : 'failed';
      await client.query('UPDATE whatsapp_attempts SET state=$2,error_code=$3,error_message=$4,completed_at=$5 WHERE id=$1', [attempt.id,failure.kind === 'uncertain' ? 'uncertain' : 'rejected',failure.code,failure.message,now]);
      await client.query('UPDATE whatsapp_messages SET state=$2,error_code=$3,error_message=$4,next_attempt_at=$5,updated_at=$6 WHERE id=$1',
        [attempt.message.id,state,failure.code,failure.message,new Date(now.getTime()+30_000 * 2 ** (attempt.number-1)),now]);
    });
  }

  receiveDelivery(input: WhatsAppDelivery, now: Date) { return this.transaction(input,(client) => recordWhatsAppDelivery(client,input,now)); }

  async recover(scope: WhatsAppScope, now: Date) {
    await this.transaction(scope, async (client) => {
      const expired = (await client.query<{ id: string; messageId: string }>(`UPDATE whatsapp_attempts a SET state='uncertain',error_code='SEND_INTERRUPTED',
        error_message='El envío se interrumpió sin confirmación.',completed_at=$3 FROM whatsapp_messages m JOIN whatsapp_conversations c ON c.id=m.conversation_id
        WHERE a.message_id=m.id AND c.account_sid=$1 AND c.business_phone=$2 AND a.state='sending' AND a.lease_until<=$3 RETURNING a.id,a.message_id AS "messageId"`, [scope.accountSid,scope.businessPhone,now])).rows;
      for (const item of expired) await client.query("UPDATE whatsapp_messages SET state='reconciliation',error_code='SEND_INTERRUPTED',error_message='Consulta el intento antes de reenviar.',updated_at=$2 WHERE id=$1", [item.messageId,now]);
      await client.query(`UPDATE whatsapp_inbox_jobs j SET state=CASE WHEN attempts<3 THEN 'pending' ELSE 'failed' END,lease_token=NULL,lease_until=NULL,next_attempt_at=$3,
        error_code='LEASE_EXPIRED',error_message='El proceso anterior no confirmó el trabajo dentro de su reserva.'
        FROM whatsapp_messages m JOIN whatsapp_conversations c ON c.id=m.conversation_id WHERE j.message_id=m.id AND c.account_sid=$1 AND c.business_phone=$2
        AND j.state='processing' AND j.lease_until<=$3`, [scope.accountSid,scope.businessPhone,now]);
    });
  }
}
