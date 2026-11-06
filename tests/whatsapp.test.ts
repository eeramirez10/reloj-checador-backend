import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import twilio from 'twilio';
import { normalizePhoneNumber, normalizeWhatsAppAddress } from '../src/infrastructure/integrations/twilio/phone-number.js';
import { incomingWhatsAppPath, statusWhatsAppPath, whatsappConfiguration, whatsappEnvironment, type WhatsAppConfiguration } from '../src/infrastructure/config/whatsapp.js';
import { TwilioWebhookSignature } from '../src/infrastructure/integrations/twilio/twilio-webhook-signature.js';
import { TwilioWhatsAppClient } from '../src/infrastructure/integrations/twilio/twilio-whatsapp-client.js';
import { isWhatsAppWindowOpen, mergeDeliveryState } from '../src/domain/entities/whatsapp-message.js';
import { validateWhatsAppContent } from '../src/domain/use-cases/send-whatsapp-message.js';

const configuration: WhatsAppConfiguration = { accountSid: `AC${'1'.repeat(32)}`, authToken: 'a'.repeat(32), businessPhone: '+14155552671', country: 'MX',
  incomingUrl: `https://hooks.example.test/backend${incomingWhatsAppPath}?region=mx`, statusUrl: `https://hooks.example.test/backend${statusWhatsAppPath}?region=mx`,
  templates: { leave_request: { contentSid: `HX${'2'.repeat(32)}`, variables: ['employeeName','requestReference'] } } };

describe('WhatsApp phone identities', () => {
  it('normalizes national and explicit international numbers without rewriting historical Mexican prefixes', () => {
    expect(normalizePhoneNumber('(55) 1234-5678','MX')).toBe('+525512345678');
    expect(normalizePhoneNumber('+1 (415) 555-2671','MX')).toBe('+14155552671');
    expect(normalizeWhatsAppAddress('whatsapp:+525512345678','MX')).toBe('+525512345678');
    for (const phone of ['555','+5215512345678','abc5512345678','whatsapp:+525512345678']) expect(() => normalizePhoneNumber(phone,'MX')).toThrow();
    for (const phone of ['+525512345678','sms:+525512345678','whatsapp:whatsapp:+525512345678']) expect(() => normalizeWhatsAppAddress(phone,'MX')).toThrow();
  });
});

describe('Twilio configuration and signed public URLs', () => {
  it('starts disabled without credentials and requires real-shaped credentials and HTTPS routes when enabled', () => {
    const schema = z.object(whatsappEnvironment);
    expect(whatsappConfiguration(schema.parse({}))).toBeUndefined();
    const environment = { TWILIO_WHATSAPP_ENABLED: 'true', TWILIO_ACCOUNT_SID: configuration.accountSid,
      TWILIO_AUTH_TOKEN: configuration.authToken, TWILIO_WHATSAPP_FROM: `whatsapp:${configuration.businessPhone}`, PUBLIC_API_URL: 'https://hooks.example.test/backend' };
    expect(whatsappConfiguration(schema.parse(environment))?.incomingUrl).toBe(`https://hooks.example.test/backend${incomingWhatsAppPath}`);
    for (const change of [{ TWILIO_AUTH_TOKEN: 'REEMPLAZAR' }, { PUBLIC_API_URL: 'http://hooks.example.test' },
      { TWILIO_WHATSAPP_FROM: 'sms:+14155552671' }, { TWILIO_WHATSAPP_TEMPLATES: '{"invalid":{"contentSid":"HX_REEMPLAZAR","variables":[]}}' },
      { TWILIO_STATUS_CALLBACK_URL: `https://hooks.example.test${statusWhatsAppPath}?attemptId=reserved` }]) {
      expect(() => whatsappConfiguration(schema.parse({ ...environment,...change }))).toThrow();
    }
  });

  it('uses the configured HTTPS prefix and exact query and includes all signed form parameters', () => {
    const security = new TwilioWebhookSignature(configuration);
    const form = { MessageSid: `SM${'3'.repeat(32)}`, Body: 'Texto con + y acentos: día', Extra: ['one','two'] };
    const signature = twilio.getExpectedTwilioSignature(configuration.authToken,configuration.incomingUrl,form);
    expect(security.validate('incoming',`${incomingWhatsAppPath}?region=mx`,signature,form)).toBe(true);
    expect(security.validate('incoming',incomingWhatsAppPath,signature,form)).toBe(false);
    expect(security.validate('incoming',`${incomingWhatsAppPath}?region=other`,signature,form)).toBe(false);
    expect(security.validate('incoming',`${incomingWhatsAppPath}?region=mx`,signature,{ ...form, Body: 'alterado' })).toBe(false);
    expect(security.validate('incoming',`${incomingWhatsAppPath}?region=mx&bodySHA256=anything`,signature,form)).toBe(false);
  });
});

describe('Twilio adapter and delivery rules', () => {
  it('maps approved template variables by configured order, uses only server callback URLs and never combines body with contentSid', async () => {
    const calls: any[] = [];
    const client = new TwilioWhatsAppClient(configuration,{ messages: { create: async (input) => { calls.push(input); return { sid: `SM${'4'.repeat(32)}`, status: 'queued' }; } } });
    const attemptId = 'c36c54c0-e676-4cf4-af9a-ea221c02edca';
    expect(await client.send({ attemptId,recipientPhone: '+525512345678',content: { kind: 'template',templateKey: 'leave_request',variables: { requestReference: 'folio-1',employeeName: 'María' } } })).toMatchObject({ providerStatus: 'queued' });
    expect(calls[0]).toEqual({ from: 'whatsapp:+14155552671',to: 'whatsapp:+525512345678',
      statusCallback: `${configuration.statusUrl}&attemptId=${attemptId}`,contentSid: configuration.templates.leave_request.contentSid,contentVariables: '{"1":"María","2":"folio-1"}' });
    await expect(client.send({ attemptId,recipientPhone: '+525512345678',content: { kind: 'template',templateKey: 'leave_request',variables: { employeeName: 'María' } } })).rejects.toThrow();
    expect(() => validateWhatsAppContent({ kind: 'template',templateKey: 'toString',variables: {} },{})).toThrow();
    expect(calls).toHaveLength(1);
  });

  it('treats rate limits as retryable and ambiguous timeouts or server failures as requiring reconciliation', () => {
    const client = new TwilioWhatsAppClient(configuration,{ messages: { create: async () => ({ sid: '',status: '' }) } });
    expect(client.classifyError({ status: 429,code: 20429 }).kind).toBe('retryable');
    expect(client.classifyError({ status: 400,code: 63016 }).kind).toBe('permanent');
    expect(client.classifyError({ code: 'ETIMEDOUT' }).kind).toBe('uncertain');
    expect(client.classifyError({ status: 500 }).kind).toBe('uncertain');
  });

  it('keeps delivery monotonic and marks contradictory terminal evidence for reconciliation', () => {
    expect(mergeDeliveryState('read','sent')).toBe('read');
    expect(mergeDeliveryState('failed','queued')).toBe('failed');
    expect(mergeDeliveryState('read','failed')).toBe('reconciliation');
    expect(mergeDeliveryState('failed','delivered')).toBe('reconciliation');
    expect(mergeDeliveryState('reconciliation','sent')).toBe('reconciliation');
    const now = new Date('2026-10-30T20:00:00Z');
    expect(isWhatsAppWindowOpen(null,now)).toBe(false);
    expect(isWhatsAppWindowOpen(new Date(now.getTime()-24*3600000),now)).toBe(false);
    expect(isWhatsAppWindowOpen(new Date(now.getTime()-24*3600000+1),now)).toBe(true);
    expect(isWhatsAppWindowOpen(new Date(now.getTime()+1),now)).toBe(false);
  });
});
