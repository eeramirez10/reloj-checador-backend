import { z } from 'zod';
import type { TwilioForm } from '../../domain/datasources/whatsapp-messaging.js';
import { ConfigurationError } from '../../domain/errors/app-error.js';

const sid = z.string().regex(/^(SM|MM)[0-9a-f]{32}$/i);
export const incomingTwilioSchema = z.object({
  AccountSid: z.string().regex(/^AC[0-9a-f]{32}$/i), MessageSid: sid, From: z.string().max(40), To: z.string().max(40),
  Body: z.string().max(5000).default(''), NumMedia: z.string().regex(/^\d{1,2}$/).default('0').transform(Number).refine((value) => value <= 10),
});
export const statusTwilioSchema = z.object({
  AccountSid: z.string().regex(/^AC[0-9a-f]{32}$/i), MessageSid: sid, From: z.string().max(40), To: z.string().max(40),
  MessageStatus: z.string().min(1).max(40), ErrorCode: z.string().regex(/^\d{1,10}$/).optional(),
});

export function twilioAttachments(form: TwilioForm, count: number) {
  const media = z.object({ url: z.string().url().max(2048).refine((value) => new URL(value).protocol === 'https:'), contentType: z.string().min(3).max(120) });
  return Array.from({ length: count }, (_,index) => {
    const parsed = media.safeParse({ url: form[`MediaUrl${index}`], contentType: form[`MediaContentType${index}`] });
    if (!parsed.success) throw new ConfigurationError('Los datos del adjunto de WhatsApp son inválidos.');
    return parsed.data;
  });
}
