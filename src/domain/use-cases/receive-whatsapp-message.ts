import type { WhatsAppInbound, WhatsAppScope } from '../entities/whatsapp-message.js';
import type { WhatsAppRepository } from '../repositories/whatsapp-repository.js';
import { ConfigurationError } from '../errors/app-error.js';

export class ReceiveWhatsAppMessage {
  constructor(private readonly repository: WhatsAppRepository, private readonly scope: WhatsAppScope, private readonly now = () => new Date()) {}
  execute(input: WhatsAppInbound) {
    if (input.accountSid !== this.scope.accountSid || input.businessPhone !== this.scope.businessPhone) throw new ConfigurationError('Cuenta o remitente de WhatsApp incorrectos.');
    return this.repository.receive(input, this.now());
  }
}
