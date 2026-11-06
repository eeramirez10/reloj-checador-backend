import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { WhatsAppContent, WhatsAppEmployee, WhatsAppMessage, WhatsAppScope } from '../../domain/entities/whatsapp-message.js';
import { ConfigurationError, ConflictError } from '../../domain/errors/app-error.js';
import type { Queryable } from '../database/database.js';

export const whatsappMessageColumns = `m.id,m.conversation_id AS "conversationId",m.account_sid AS "accountSid",m.employee_id AS "employeeId",
  c.business_phone AS "businessPhone",c.participant_phone AS "participantPhone",m.direction,m.content,m.attachments,m.state,m.provider_message_id AS "providerMessageId"`;

export async function authorizedWhatsAppEmployee(client: Queryable, phone?: string, id?: string): Promise<WhatsAppEmployee | null> {
  return (await client.query<WhatsAppEmployee>(`SELECT e.id,e.name,p.whatsapp_phone AS phone FROM employees e
    JOIN employee_leave_profiles p ON p.employee_id=e.id WHERE e.is_active AND e.identification_status='confirmed'
    AND p.whatsapp_phone IS NOT NULL AND ($1::text IS NULL OR p.whatsapp_phone=$1) AND ($2::uuid IS NULL OR e.id=$2)`, [phone ?? null, id ?? null])).rows[0] ?? null;
}

export async function whatsappConversation(client: Queryable, scope: WhatsAppScope, phone: string, employeeId: string | null): Promise<string> {
  const id = randomUUID();
  await client.query(`INSERT INTO whatsapp_conversations (id,account_sid,business_phone,participant_phone,employee_id)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_sid,business_phone,participant_phone) DO NOTHING`, [id,scope.accountSid,scope.businessPhone,phone,employeeId]);
  return (await client.query<{ id: string }>('SELECT id FROM whatsapp_conversations WHERE account_sid=$1 AND business_phone=$2 AND participant_phone=$3', [scope.accountSid,scope.businessPhone,phone])).rows[0].id;
}

export async function loadWhatsAppMessage(client: Queryable, id: string): Promise<WhatsAppMessage> {
  return (await client.query<WhatsAppMessage>(`SELECT ${whatsappMessageColumns} FROM whatsapp_messages m JOIN whatsapp_conversations c ON c.id=m.conversation_id WHERE m.id=$1`, [id])).rows[0];
}

export async function enqueueWhatsApp(client: Queryable, scope: WhatsAppScope, employeeId: string, content: WhatsAppContent, key: string, now: Date): Promise<WhatsAppMessage> {
  const employee = await authorizedWhatsAppEmployee(client, undefined, employeeId);
  if (!employee) throw new ConfigurationError('El empleado no tiene un WhatsApp autorizado.');
  const conversationId = await whatsappConversation(client, scope, employee.phone, employee.id);
  const existing = (await client.query<{ id: string }>('SELECT id FROM whatsapp_messages WHERE conversation_id=$1 AND idempotency_key=$2', [conversationId,key])).rows[0];
  if (existing) {
    const message = await loadWhatsAppMessage(client, existing.id);
    if (message.employeeId !== employee.id || !isDeepStrictEqual(message.content, content)) throw new ConflictError('La clave de WhatsApp ya corresponde a otra operación.');
    return message;
  }
  const id = randomUUID();
  await client.query(`INSERT INTO whatsapp_messages (id,conversation_id,account_sid,employee_id,direction,content,state,idempotency_key,next_attempt_at,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'outbound',$5::jsonb,'pending',$6,$7,$7,$7)`, [id,conversationId,scope.accountSid,employee.id,JSON.stringify(content),key,now]);
  return loadWhatsAppMessage(client,id);
}
