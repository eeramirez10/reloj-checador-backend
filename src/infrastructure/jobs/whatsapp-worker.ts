import type { WhatsAppRepository } from '../../domain/repositories/whatsapp-repository.js';
import type { WhatsAppScope } from '../../domain/entities/whatsapp-message.js';
import type { ProcessWhatsAppInbox } from '../../domain/use-cases/process-whatsapp-inbox.js';
import type { SendWhatsAppMessage } from '../../domain/use-cases/send-whatsapp-message.js';

interface WhatsAppWorkerLogger { error(data: { operation: string }, message: string): void }

export class WhatsAppWorker {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  constructor(private readonly repository: WhatsAppRepository, private readonly scope: WhatsAppScope,
    private readonly inbox: ProcessWhatsAppInbox, private readonly sender: SendWhatsAppMessage,
    private readonly logger: WhatsAppWorkerLogger = console, private readonly now = () => new Date()) {}
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(),2000); this.timer.unref();
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.inFlight; }
  tick(): Promise<void> {
    if (!this.inFlight) this.inFlight = this.run().catch(() => this.logger.error({ operation: 'whatsapp-worker' },'No se pudo completar el ciclo de WhatsApp.'))
      .finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async run(): Promise<void> {
    await this.repository.recover(this.scope,this.now());
    for (let index=0;index<10;index++) {
      const received = await this.inbox.processNext();
      const sent = await this.sender.processNext();
      if (!received && !sent) break;
    }
  }
}
