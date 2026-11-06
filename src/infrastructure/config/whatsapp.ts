import { z } from 'zod';
import type { WhatsAppScope, WhatsAppTemplateDefinition } from '../../domain/entities/whatsapp-message.js';
import { normalizeWhatsAppAddress, phoneCountry } from '../integrations/twilio/phone-number.js';
import type { CountryCode } from 'libphonenumber-js';

export const whatsappEnvironment = {
  TWILIO_WHATSAPP_ENABLED: z.enum(['true','false']).default('false').transform((value) => value === 'true'),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_WHATSAPP_FROM: z.string().default(''),
  PUBLIC_API_URL: z.string().default(''),
  TWILIO_INCOMING_WEBHOOK_URL: z.string().default(''),
  TWILIO_STATUS_CALLBACK_URL: z.string().default(''),
  TWILIO_WHATSAPP_TEMPLATES: z.string().default('{}'),
  PHONE_DEFAULT_COUNTRY: z.string().default('MX').transform(phoneCountry),
};
export interface WhatsAppTemplateConfig extends WhatsAppTemplateDefinition { contentSid: string }
export interface WhatsAppConfiguration extends WhatsAppScope {
  authToken: string; country: CountryCode; incomingUrl: string; statusUrl: string;
  templates: Record<string, WhatsAppTemplateConfig>;
}
export const incomingWhatsAppPath = '/integrations/twilio/whatsapp/incoming';
export const statusWhatsAppPath = '/integrations/twilio/whatsapp/status';

const publicUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
}, 'Las URLs públicas de Twilio requieren HTTPS y no deben contener credenciales ni fragmentos.');
const templateSchema = z.record(z.string().min(1).max(100), z.object({
  contentSid: z.string().regex(/^HX[0-9a-f]{32}$/i),
  variables: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/)).max(100).refine((keys) => new Set(keys).size === keys.length),
}).strict());

export function whatsappConfiguration(environment: z.output<z.ZodObject<typeof whatsappEnvironment>>): WhatsAppConfiguration | undefined {
  if (!environment.TWILIO_WHATSAPP_ENABLED) return undefined;
  const base = environment.PUBLIC_API_URL ? publicUrl.parse(environment.PUBLIC_API_URL).replace(/\/$/, '') : '';
  if (base && new URL(base).search) throw new Error('PUBLIC_API_URL no debe contener query string.');
  const incomingUrl = publicUrl.parse(environment.TWILIO_INCOMING_WEBHOOK_URL || (base ? base+incomingWhatsAppPath : ''));
  const statusUrl = publicUrl.parse(environment.TWILIO_STATUS_CALLBACK_URL || (base ? base+statusWhatsAppPath : ''));
  if (!new URL(incomingUrl).pathname.endsWith(incomingWhatsAppPath) || !new URL(statusUrl).pathname.endsWith(statusWhatsAppPath)
    || new URL(statusUrl).searchParams.has('attemptId') || new URL(incomingUrl).searchParams.has('bodySHA256') || new URL(statusUrl).searchParams.has('bodySHA256')) {
    throw new Error('Revisa las rutas externas de Twilio; attemptId y bodySHA256 son parámetros reservados.');
  }
  return { accountSid: z.string().regex(/^AC[0-9a-f]{32}$/).parse(environment.TWILIO_ACCOUNT_SID),
    authToken: z.string().regex(/^[0-9a-f]{32}$/i).parse(environment.TWILIO_AUTH_TOKEN),
    businessPhone: normalizeWhatsAppAddress(environment.TWILIO_WHATSAPP_FROM, environment.PHONE_DEFAULT_COUNTRY),
    country: environment.PHONE_DEFAULT_COUNTRY, incomingUrl, statusUrl,
    templates: templateSchema.parse(JSON.parse(environment.TWILIO_WHATSAPP_TEMPLATES)),
  };
}
