import { randomUUID } from 'node:crypto';
import type { WhatsAppDelivery, WhatsAppDeliveryState } from '../../domain/entities/whatsapp-message.js';
import { deliveryState, mergeDeliveryState } from '../../domain/entities/whatsapp-message.js';
import type { Queryable } from '../database/database.js';

interface CorrelatedAttempt {
  id: string; messageId: string; providerMessageId: string | null; deliveryState: WhatsAppDeliveryState; sendState: string;
}

export async function recordWhatsAppDelivery(client: Queryable, input: WhatsAppDelivery, now: Date): Promise<void> {
  const inserted = (await client.query<{ id: string }>(`INSERT INTO whatsapp_delivery_events (id,account_sid,business_phone,participant_phone,
    provider_message_id,provider_status,error_code,event_key,correlation_attempt_id,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (account_sid,event_key) DO NOTHING RETURNING id`,
  [randomUUID(),input.accountSid,input.businessPhone,input.participantPhone,input.providerMessageId,input.providerStatus,input.errorCode ?? null,input.eventKey,input.attemptId ?? null,now])).rows[0];
  if (inserted) await applyWhatsAppDelivery(client, inserted.id);
}

export async function applyWhatsAppDelivery(client: Queryable, eventId: string): Promise<void> {
  const event = (await client.query<WhatsAppDelivery>(`SELECT account_sid AS "accountSid",business_phone AS "businessPhone",participant_phone AS "participantPhone",
    provider_message_id AS "providerMessageId",provider_status AS "providerStatus",error_code AS "errorCode",correlation_attempt_id AS "attemptId",event_key AS "eventKey"
    FROM whatsapp_delivery_events WHERE id=$1 AND attempt_id IS NULL`, [eventId])).rows[0];
  if (!event) return;
  const attempt = (await client.query<CorrelatedAttempt>(`SELECT a.id,a.message_id AS "messageId",a.provider_message_id AS "providerMessageId",a.state AS "sendState",m.state AS "deliveryState"
    FROM whatsapp_attempts a JOIN whatsapp_messages m ON m.id=a.message_id JOIN whatsapp_conversations c ON c.id=m.conversation_id
    WHERE m.account_sid=$1 AND c.business_phone=$2 AND c.participant_phone=$3
    AND (($4::uuid IS NOT NULL AND a.id=$4) OR ($4::uuid IS NULL AND a.provider_message_id=$5)) FOR UPDATE OF a,m`,
  [event.accountSid,event.businessPhone,event.participantPhone,event.attemptId ?? null,event.providerMessageId])).rows[0];
  if (!attempt) return;
  if (attempt.providerMessageId && attempt.providerMessageId !== event.providerMessageId) {
    await client.query("UPDATE whatsapp_messages SET state='reconciliation',error_code='SID_CONFLICT',error_message='Los identificadores del proveedor no coinciden.' WHERE id=$1", [attempt.messageId]);
    return;
  }
  const incoming = deliveryState(event.providerStatus);
  const previous = attempt.deliveryState === 'reconciliation' && attempt.sendState === 'uncertain' && !attempt.providerMessageId ? 'sending' : attempt.deliveryState;
  const state = incoming ? mergeDeliveryState(previous,incoming) : event.eventKey.startsWith('api:') ? 'reconciliation' : previous;
  await client.query('UPDATE whatsapp_delivery_events SET attempt_id=$2 WHERE id=$1', [eventId,attempt.id]);
  await client.query(`UPDATE whatsapp_attempts SET provider_message_id=$2,provider_status=$3,state='accepted',completed_at=COALESCE(completed_at,NOW()) WHERE id=$1`, [attempt.id,event.providerMessageId,event.providerStatus]);
  await client.query(`UPDATE whatsapp_messages SET provider_message_id=$2,state=$3,error_code=$4,error_message=$5,updated_at=NOW() WHERE id=$1`,
    [attempt.messageId,event.providerMessageId,state,state === 'reconciliation' ? 'DELIVERY_CONFLICT' : state === 'failed' ? event.errorCode ?? 'DELIVERY_FAILED' : null,
      state === 'reconciliation' ? 'El estado de entrega requiere conciliación con Twilio.' : state === 'failed' ? 'Twilio informó que el mensaje no se entregó.' : null]);
}
