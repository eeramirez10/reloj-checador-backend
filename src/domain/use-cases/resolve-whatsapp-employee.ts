import type { WhatsAppRepository } from '../repositories/whatsapp-repository.js';

export class ResolveWhatsAppEmployee {
  constructor(private readonly repository: Pick<WhatsAppRepository, 'resolveEmployee'>) {}
  execute(phone: string) { return this.repository.resolveEmployee(phone); }
}
