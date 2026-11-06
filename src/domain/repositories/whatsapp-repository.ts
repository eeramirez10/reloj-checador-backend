import type { WhatsAppAttempt, WhatsAppContent, WhatsAppDelivery, WhatsAppEmployee, WhatsAppInbound, WhatsAppInboxJob, WhatsAppMessage, WhatsAppReceipt, WhatsAppScope, WhatsAppSendFailure } from '../entities/whatsapp-message.js';

export interface WhatsAppRepository {
  resolveEmployee(phone: string): Promise<WhatsAppEmployee | null>;
  receive(input: WhatsAppInbound, now: Date): Promise<{ id: string; created: boolean; authorized: boolean }>;
  enqueue(scope: WhatsAppScope, employeeId: string, content: WhatsAppContent, idempotencyKey: string, now: Date): Promise<WhatsAppMessage>;
  claimInbox(scope: WhatsAppScope, now: Date): Promise<WhatsAppInboxJob | null>;
  finishInbox(job: WhatsAppInboxJob, state: 'completed' | 'blocked' | 'awaiting_handler', reply: WhatsAppContent | null, now: Date): Promise<void>;
  failInbox(job: WhatsAppInboxJob, now: Date): Promise<void>;
  claimOutbound(scope: WhatsAppScope, now: Date): Promise<WhatsAppAttempt | null>;
  accept(attempt: WhatsAppAttempt, receipt: WhatsAppReceipt, now: Date): Promise<void>;
  fail(attempt: WhatsAppAttempt, failure: WhatsAppSendFailure, now: Date): Promise<void>;
  receiveDelivery(input: WhatsAppDelivery, now: Date): Promise<void>;
  recover(scope: WhatsAppScope, now: Date): Promise<void>;
}
