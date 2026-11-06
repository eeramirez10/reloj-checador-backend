import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApplicationServices } from '../services.js';
import type { TwilioForm } from '../../domain/datasources/whatsapp-messaging.js';
import { incomingTwilioSchema, statusTwilioSchema, twilioAttachments } from '../validators/twilio-whatsapp.js';

export class TwilioWebhookController {
  constructor(private readonly services: Pick<ApplicationServices, 'whatsapp'>) {}

  private validated(kind: 'incoming' | 'status', request: FastifyRequest, reply: FastifyReply) {
    const integration = this.services.whatsapp;
    if (!integration) { reply.code(503).send({ message: 'La integración de WhatsApp está desactivada.' }); return null; }
    const parameters = request.body as TwilioForm;
    const signature = request.headers['x-twilio-signature'];
    if (typeof signature !== 'string' || !integration.security.validate(kind,request.raw.url ?? '',signature,parameters)) {
      reply.code(403).send({ message: 'Firma de Twilio inválida.' }); return null;
    }
    return { integration, parameters };
  }

  incoming = async (request: FastifyRequest, reply: FastifyReply) => {
    const validated = this.validated('incoming',request,reply);
    if (!validated) return;
    const { integration, parameters } = validated;
    const parsed = incomingTwilioSchema.safeParse(parameters);
    if (!parsed.success) return reply.code(400).send({ message: 'Mensaje entrante de Twilio inválido.' });
    const input = parsed.data;
    const businessPhone = integration.security.normalizeAddress(input.To);
    const participantPhone = integration.security.normalizeAddress(input.From);
    if (input.AccountSid !== integration.scope.accountSid || businessPhone !== integration.scope.businessPhone) return reply.code(403).send({ message: 'Cuenta o remitente no autorizados.' });
    await integration.receive.execute({ accountSid: input.AccountSid, businessPhone, participantPhone, providerMessageId: input.MessageSid,
      body: input.Body, attachments: twilioAttachments(parameters,input.NumMedia) });
    return reply.type('text/xml').send('<Response></Response>');
  };

  status = async (request: FastifyRequest, reply: FastifyReply) => {
    const validated = this.validated('status',request,reply);
    if (!validated) return;
    const { integration, parameters } = validated;
    const parsed = statusTwilioSchema.safeParse(parameters);
    const query = z.object({ attemptId: z.string().uuid().optional() }).safeParse(request.query);
    if (!parsed.success || !query.success) return reply.code(400).send({ message: 'Estado de Twilio inválido.' });
    const input = parsed.data;
    const businessPhone = integration.security.normalizeAddress(input.From);
    const participantPhone = integration.security.normalizeAddress(input.To);
    if (input.AccountSid !== integration.scope.accountSid || businessPhone !== integration.scope.businessPhone) return reply.code(403).send({ message: 'Cuenta o remitente no autorizados.' });
    const event = { accountSid: input.AccountSid, businessPhone, participantPhone, providerMessageId: input.MessageSid,
      providerStatus: input.MessageStatus, errorCode: input.ErrorCode, attemptId: query.data.attemptId };
    await integration.delivery.execute({ ...event, eventKey: createHash('sha256').update(JSON.stringify(event)).digest('hex') });
    return reply.type('text/xml').send('<Response></Response>');
  };
}
