import twilio from 'twilio';
import type { TwilioForm, WhatsAppWebhookSecurity } from '../../../domain/datasources/whatsapp-messaging.js';
import type { WhatsAppConfiguration } from '../../config/whatsapp.js';
import { incomingWhatsAppPath, statusWhatsAppPath } from '../../config/whatsapp.js';
import { normalizeWhatsAppAddress } from './phone-number.js';

export class TwilioWebhookSignature implements WhatsAppWebhookSecurity {
  constructor(private readonly configuration: WhatsAppConfiguration) {}

  validate(kind: 'incoming' | 'status', requestUrl: string, signature: string, parameters: TwilioForm): boolean {
    if (!signature || signature.length > 128) return false;
    const configured = new URL(kind === 'incoming' ? this.configuration.incomingUrl : this.configuration.statusUrl);
    const received = new URL(requestUrl, 'http://internal.invalid');
    if (received.pathname !== (kind === 'incoming' ? incomingWhatsAppPath : statusWhatsAppPath) || received.searchParams.has('bodySHA256')) return false;
    for (const key of configured.searchParams.keys()) {
      if (JSON.stringify(received.searchParams.getAll(key)) !== JSON.stringify(configured.searchParams.getAll(key))) return false;
    }
    const query = requestUrl.includes('?') ? requestUrl.slice(requestUrl.indexOf('?')) : '';
    const externalUrl = `${configured.origin}${configured.pathname}${query}`;
    return twilio.validateRequest(this.configuration.authToken,signature,externalUrl,parameters);
  }

  normalizeAddress(value: string) { return normalizeWhatsAppAddress(value,this.configuration.country); }
}
