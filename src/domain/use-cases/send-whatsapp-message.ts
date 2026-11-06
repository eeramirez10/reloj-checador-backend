import type { WhatsAppContent, WhatsAppScope, WhatsAppTemplateDefinition } from '../entities/whatsapp-message.js';
import { isWhatsAppWindowOpen } from '../entities/whatsapp-message.js';
import type { WhatsAppMessaging } from '../datasources/whatsapp-messaging.js';
import type { WhatsAppRepository } from '../repositories/whatsapp-repository.js';
import { ConfigurationError } from '../errors/app-error.js';

export function validateWhatsAppContent(content: WhatsAppContent, templates: Record<string, WhatsAppTemplateDefinition>): void {
  if (content.kind === 'text') {
    if (!content.body.trim() || content.body.length > 1600) throw new ConfigurationError('El mensaje debe contener entre 1 y 1600 caracteres.');
    return;
  }
  const definition = Object.hasOwn(templates,content.templateKey) ? templates[content.templateKey] : undefined;
  if (!definition || Object.keys(content.variables).length !== definition.variables.length
    || definition.variables.some((key) => typeof content.variables[key] !== 'string' || !content.variables[key].trim() || content.variables[key].length > 1024)) {
    throw new ConfigurationError('La plantilla de WhatsApp o sus variables no están configuradas correctamente.');
  }
}

export class SendWhatsAppMessage {
  constructor(private readonly repository: WhatsAppRepository, private readonly messaging: WhatsAppMessaging,
    private readonly scope: WhatsAppScope, private readonly templates: Record<string, WhatsAppTemplateDefinition>, private readonly now = () => new Date()) {}

  enqueue(employeeId: string, content: WhatsAppContent, idempotencyKey: string) {
    validateWhatsAppContent(content, this.templates);
    if (!idempotencyKey.trim() || idempotencyKey.length > 200) throw new ConfigurationError('Indica una clave de operación válida.');
    return this.repository.enqueue(this.scope, employeeId, content, idempotencyKey, this.now());
  }

  async processNext(): Promise<boolean> {
    const attempt = await this.repository.claimOutbound(this.scope, this.now());
    if (!attempt) return false;
    const employee = await this.repository.resolveEmployee(attempt.message.participantPhone);
    if (!employee || employee.id !== attempt.message.employeeId) {
      await this.repository.fail(attempt, { kind: 'permanent', code: 'UNAUTHORIZED_RECIPIENT', message: 'El teléfono ya no pertenece a un empleado autorizado.' }, this.now());
      return true;
    }
    if (attempt.message.content.kind === 'text' && !isWhatsAppWindowOpen(attempt.lastInboundAt, this.now())) {
      await this.repository.fail(attempt, { kind: 'permanent', code: 'TEMPLATE_REQUIRED', message: 'Se requiere una plantilla aprobada fuera de la ventana de 24 horas.' }, this.now());
      return true;
    }
    try {
      validateWhatsAppContent(attempt.message.content, this.templates);
    } catch {
      await this.repository.fail(attempt, { kind: 'permanent', code: 'INVALID_TEMPLATE', message: 'La plantilla o contenido ya no están disponibles.' }, this.now());
      return true;
    }
    let receipt;
    try { receipt = await this.messaging.send({ attemptId: attempt.id, recipientPhone: employee.phone, content: attempt.message.content }); }
    catch (error) { await this.repository.fail(attempt, this.messaging.classifyError(error), this.now()); return true; }
    await this.repository.accept(attempt, receipt, this.now());
    return true;
  }
}
