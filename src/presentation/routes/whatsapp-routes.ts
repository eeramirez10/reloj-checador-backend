import type { FastifyInstance } from 'fastify';
import type { ApplicationServices } from '../services.js';
import type { TwilioForm } from '../../domain/datasources/whatsapp-messaging.js';
import { TwilioWebhookController } from '../controllers/twilio-webhook-controller.js';

export function registerWhatsAppRoutes(app: FastifyInstance, services: Pick<ApplicationServices, 'whatsapp'>): void {
  void app.register(async (webhooks) => {
    webhooks.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 65_536 }, (_request,body,done) => {
      const form: TwilioForm = Object.create(null) as TwilioForm;
      const parameters = new URLSearchParams(String(body));
      for (const key of new Set(parameters.keys())) {
        const values = parameters.getAll(key); form[key] = values.length === 1 ? values[0] : values;
      }
      done(null,form);
    });
    webhooks.addHook('onRequest', async (request,reply) => {
      if (!services.whatsapp) return reply.code(503).send({ message: 'La integración de WhatsApp está desactivada.' });
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') {
        return reply.code(415).send({ message: 'El webhook de Twilio requiere un formulario URL-encoded.' });
      }
    });
    const controller = new TwilioWebhookController(services);
    webhooks.post('/integrations/twilio/whatsapp/incoming', { bodyLimit: 65_536 }, controller.incoming);
    webhooks.post('/integrations/twilio/whatsapp/status', { bodyLimit: 65_536 }, controller.status);
  });
}
