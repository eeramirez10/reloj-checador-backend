import twilio from 'twilio';
import type { WhatsAppMessaging } from '../../../domain/datasources/whatsapp-messaging.js';
import type { WhatsAppContent, WhatsAppSendFailure } from '../../../domain/entities/whatsapp-message.js';
import { validateWhatsAppContent } from '../../../domain/use-cases/send-whatsapp-message.js';
import type { WhatsAppConfiguration } from '../../config/whatsapp.js';
import { normalizePhoneNumber } from './phone-number.js';

type TwilioMessageInput = Parameters<ReturnType<typeof twilio>['messages']['create']>[0];
export interface TwilioMessagesClient {
  messages: { create(input: TwilioMessageInput): Promise<{ sid: string; status: string }> };
}

export class TwilioWhatsAppClient implements WhatsAppMessaging {
  private readonly client: TwilioMessagesClient;
  constructor(private readonly configuration: WhatsAppConfiguration, client?: TwilioMessagesClient) {
    this.client = client ?? twilio(configuration.accountSid,configuration.authToken,{ timeout: 10_000, autoRetry: false });
  }

  async send(input: { attemptId: string; recipientPhone: string; content: WhatsAppContent }) {
    validateWhatsAppContent(input.content,this.configuration.templates);
    const recipient = normalizePhoneNumber(input.recipientPhone,this.configuration.country);
    const callback = new URL(this.configuration.statusUrl); callback.searchParams.set('attemptId',input.attemptId);
    const parameters: TwilioMessageInput = { from: `whatsapp:${this.configuration.businessPhone}`, to: `whatsapp:${recipient}`, statusCallback: callback.toString() };
    if (input.content.kind === 'text') parameters.body = input.content.body;
    else {
      const template = this.configuration.templates[input.content.templateKey];
      parameters.contentSid = template.contentSid;
      const variables = input.content.variables;
      parameters.contentVariables = JSON.stringify(Object.fromEntries(template.variables.map((key,index) => [String(index+1),variables[key]])));
    }
    const response = await this.client.messages.create(parameters);
    return { providerMessageId: response.sid, providerStatus: response.status };
  }

  classifyError(error: unknown): WhatsAppSendFailure {
    const values = typeof error === 'object' && error !== null ? error as { status?: number; code?: string | number } : {};
    const code = String(values.code ?? 'PROVIDER_UNCERTAIN').slice(0,50);
    if (values.status === 429) return { kind: 'retryable', code, message: 'Twilio limitó temporalmente la frecuencia de envío.' };
    if (values.status && values.status >= 400 && values.status < 500) return { kind: 'permanent', code, message: 'Twilio rechazó la solicitud de envío.' };
    return { kind: 'uncertain', code, message: 'No se confirmó si Twilio aceptó el envío; requiere conciliación.' };
  }
}
