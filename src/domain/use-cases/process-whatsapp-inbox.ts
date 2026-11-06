import type { WhatsAppMessageHandler } from '../datasources/whatsapp-messaging.js';
import type { WhatsAppScope, WhatsAppTemplateDefinition } from '../entities/whatsapp-message.js';
import type { WhatsAppRepository } from '../repositories/whatsapp-repository.js';
import { validateWhatsAppContent } from './send-whatsapp-message.js';

export class ProcessWhatsAppInbox {
  constructor(private readonly repository: WhatsAppRepository, private readonly scope: WhatsAppScope,
    private readonly templates: Record<string, WhatsAppTemplateDefinition>, private readonly handler?: WhatsAppMessageHandler, private readonly now = () => new Date()) {}

  async processNext(): Promise<boolean> {
    const job = await this.repository.claimInbox(this.scope, this.now());
    if (!job) return false;
    try {
      const employee = await this.repository.resolveEmployee(job.message.participantPhone);
      if (!employee || employee.id !== job.message.employeeId) { await this.repository.finishInbox(job, 'blocked', null, this.now()); return true; }
      if (!this.handler) { await this.repository.finishInbox(job, 'awaiting_handler', null, this.now()); return true; }
      const reply = await this.handler.handle({ ...job.message, employeeId: employee.id });
      if (reply) validateWhatsAppContent(reply, this.templates);
      await this.repository.finishInbox(job, 'completed', reply, this.now());
    } catch { await this.repository.failInbox(job, this.now()); }
    return true;
  }
}
