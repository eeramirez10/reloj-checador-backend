export interface WhatsAppScope { accountSid: string; businessPhone: string }
export interface WhatsAppEmployee { id: string; phone: string; name: string }
export type WhatsAppContent = { kind: 'text'; body: string }
  | { kind: 'template'; templateKey: string; variables: Record<string, string> };
export type WhatsAppDeliveryState = 'pending' | 'sending' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'reconciliation';
export interface WhatsAppAttachment { url: string; contentType: string }
export interface WhatsAppInbound extends WhatsAppScope {
  providerMessageId: string; participantPhone: string; body: string; attachments: WhatsAppAttachment[];
}
export interface WhatsAppMessage extends WhatsAppScope {
  id: string; conversationId: string; employeeId: string | null; participantPhone: string;
  direction: 'inbound' | 'outbound'; content: WhatsAppContent; attachments: WhatsAppAttachment[];
  state: WhatsAppDeliveryState | 'received' | 'unauthorized'; providerMessageId: string | null;
}
export interface WhatsAppReceipt { providerMessageId: string; providerStatus: string }
export interface WhatsAppDelivery extends WhatsAppScope, WhatsAppReceipt {
  participantPhone: string; attemptId?: string; errorCode?: string; eventKey: string;
}
export interface WhatsAppAttempt {
  id: string; message: WhatsAppMessage; number: number; lastInboundAt: Date | null;
}
export interface WhatsAppInboxJob { id: string; leaseToken: string; message: WhatsAppMessage }
export interface WhatsAppSendFailure { kind: 'permanent' | 'retryable' | 'uncertain'; code: string; message: string }
export interface WhatsAppTemplateDefinition { variables: string[] }

export function deliveryState(status: string): WhatsAppDeliveryState | null {
  if (['accepted','queued','sending','scheduled'].includes(status)) return 'queued';
  if (status === 'sent' || status === 'delivered' || status === 'read') return status;
  if (['failed','undelivered','canceled'].includes(status)) return 'failed';
  return null;
}

export function mergeDeliveryState(current: WhatsAppDeliveryState, next: WhatsAppDeliveryState): WhatsAppDeliveryState {
  if (current === 'reconciliation') return current;
  if ((current === 'failed' && ['delivered','read'].includes(next)) || (next === 'failed' && ['delivered','read'].includes(current))) return 'reconciliation';
  if (current === 'failed' || next === 'failed') return 'failed';
  const order: WhatsAppDeliveryState[] = ['pending','sending','queued','sent','delivered','read'];
  return order.indexOf(next) > order.indexOf(current) ? next : current;
}

export function isWhatsAppWindowOpen(lastInboundAt: Date | null, now: Date): boolean {
  if (!lastInboundAt) return false;
  const elapsed = now.getTime() - lastInboundAt.getTime();
  return elapsed >= 0 && elapsed < 24 * 60 * 60 * 1000;
}
