import type { DeviceRepository } from '../devices/device-repository.js';
import type { SyncService } from './sync-service.js';

export class SyncScheduler {
  private timer?: NodeJS.Timeout;
  private readonly lastScheduledAt = new Map<string, number>();
  constructor(private readonly devices: DeviceRepository, private readonly syncService: SyncService, private readonly intervalSeconds: number) {}

  start(): void {
    this.timer = setInterval(() => void this.syncAll(), this.intervalSeconds * 1000);
    this.timer.unref();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }

  async syncAll(): Promise<void> {
    const devices = await this.devices.listEnabled();
    const now = Date.now();
    const dueDevices = devices.filter((device) => {
      const lastRun = this.lastScheduledAt.get(device.id);
      const minimumInterval = Math.max(this.intervalSeconds, device.syncIntervalSeconds) * 1000;
      return !lastRun || now - lastRun >= minimumInterval;
    });
    dueDevices.forEach((device) => this.lastScheduledAt.set(device.id, now));
    await Promise.allSettled(dueDevices.map((device) => this.syncService.sync(device)));
  }
}
