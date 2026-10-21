import type { AttendanceRepository } from '../attendance/attendance-repository.js';
import type { Device } from '../devices/device-repository.js';
import type { ZktecoClientFactory } from '../integrations/zkteco/client-factory.js';
import type { SyncRepository, SyncRun } from './sync-repository.js';

export class SyncAlreadyRunningError extends Error {}

export class SyncService {
  private readonly activeDeviceIds = new Set<string>();

  constructor(private readonly attendance: AttendanceRepository, private readonly syncRuns: SyncRepository, private readonly clients: ZktecoClientFactory,
    private readonly onSynced?: () => Promise<unknown>,
    private readonly onAttendanceUsers?: (deviceId: string, userIds: string[]) => Promise<void>) {}

  async sync(device: Device): Promise<SyncRun> {
    return this.withDeviceLock(device, async () => {
      const run = await this.syncRuns.start(device.id);
      try {
        const events = await this.clients.getClient(device).getAttendance(device);
        await this.onAttendanceUsers?.(device.id, events.map((event) => event.userId));
        let inserted = 0;
        for (const event of events) if (await this.attendance.insertIfNew(device.id, event)) inserted += 1;
        await this.onSynced?.();
        return await this.syncRuns.finish(run.id, 'succeeded', { received: events.length, inserted });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Error desconocido durante la sincronización.';
        await this.syncRuns.finish(run.id, 'failed', { received: 0, inserted: 0 }, message);
        throw error;
      }
    });
  }

  async withDeviceLock<T>(device: Device, operation: () => Promise<T>): Promise<T> {
    if (this.activeDeviceIds.has(device.id)) throw new SyncAlreadyRunningError(`Ya existe una sincronización activa para ${device.name}.`);
    this.activeDeviceIds.add(device.id);
    try {
      return await operation();
    } finally {
      this.activeDeviceIds.delete(device.id);
    }
  }
}
