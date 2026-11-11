import type { DeviceRepository } from '../../domain/repositories/device-repository.js';
import type { SyncService } from '../../domain/use-cases/sync-attendance.js';
import { SyncAlreadyRunningError } from '../../domain/errors/app-error.js';

interface SchedulerLogger { error(data: { err: unknown; deviceId?: string }, message: string): void }

export class SyncScheduler {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;
  private readonly lastScheduledAt = new Map<string, number>();
  constructor(private readonly devices: DeviceRepository, private readonly syncService: Pick<SyncService, 'sync'>,
    private readonly intervalSeconds: number, private readonly logger: SchedulerLogger = console, private readonly enabled = true) {}

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => void this.syncAll(), this.intervalSeconds * 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  syncAll(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.run()
        .catch((err: unknown) => this.logger.error({ err }, 'No se pudo ejecutar el ciclo de sincronización.'))
        .finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const devices = await this.devices.listEnabled();
    const now = Date.now();
    const dueDevices = devices.filter((device) => {
      const lastRun = this.lastScheduledAt.get(device.id);
      const minimumInterval = Math.max(this.intervalSeconds, device.syncIntervalSeconds) * 1000;
      return !lastRun || now - lastRun >= minimumInterval;
    });
    dueDevices.forEach((device) => this.lastScheduledAt.set(device.id, now));
    const results = await Promise.allSettled(dueDevices.map((device) => this.syncService.sync(device)));
    results.forEach((result, index) => {
      if (result.status === 'rejected' && !(result.reason instanceof SyncAlreadyRunningError)) {
        this.logger.error({ err: result.reason, deviceId: dueDevices[index].id }, 'Falló la sincronización programada del reloj.');
      }
    });
  }
}
