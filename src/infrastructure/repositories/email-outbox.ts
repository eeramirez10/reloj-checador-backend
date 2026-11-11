import { randomUUID } from 'node:crypto';
import type { Queryable } from '../database/database.js';
import type { EmailContent } from '../../domain/datasources/email-gateway.js';
import { EmailContentCipher } from '../integrations/email-content-cipher.js';
import type { EmailSettings } from '../config/email.js';

export async function enqueueEmail(client: Queryable, settings: EmailSettings, input: {
  employeeId: string; recipient: string; kind: 'welcome' | 'leave'; content: EmailContent;
  eventId?: string; accountId?: string; accountVersion?: number; expiresAt: Date;
}) {
  const id = randomUUID();
  const encrypted = new EmailContentCipher(settings.encryptionKey).encrypt(input.content,id);
  await client.query(`INSERT INTO email_outbox(id,event_id,employee_id,account_id,account_version,kind,recipient,encrypted_content,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id,input.eventId ?? null,input.employeeId,input.accountId ?? null,input.accountVersion ?? null,input.kind,input.recipient,encrypted,input.expiresAt]);
  return id;
}
