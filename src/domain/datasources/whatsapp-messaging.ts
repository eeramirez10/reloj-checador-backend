import type { WhatsAppContent, WhatsAppMessage, WhatsAppReceipt, WhatsAppSendFailure } from '../entities/whatsapp-message.js';

export interface WhatsAppMessaging {
  send(input: { attemptId: string; recipientPhone: string; content: WhatsAppContent }): Promise<WhatsAppReceipt>;
  classifyError(error: unknown): WhatsAppSendFailure;
}
export interface WhatsAppMessageHandler {
  handle(message: WhatsAppMessage & { employeeId: string }): Promise<WhatsAppContent | null>;
}
export type TwilioForm = Record<string, string | string[]>;
export interface WhatsAppWebhookSecurity {
  validate(kind: 'incoming' | 'status', requestUrl: string, signature: string, parameters: TwilioForm): boolean;
  normalizeAddress(value: string): string;
}
