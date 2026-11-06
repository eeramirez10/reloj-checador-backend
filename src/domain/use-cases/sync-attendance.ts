import type { AttendanceRepository } from '../repositories/attendance-repository.js';
import type { Device } from '../entities/device.js';
import type { DeviceClientFactory } from '../datasources/device-client.js';
import type { SyncRepository } from '../repositories/sync-repository.js';
import type { SyncRun } from '../entities/sync-run.js';
import { SyncAlreadyRunningError, errorMessage } from '../errors/app-error.js';
export { SyncAlreadyRunningError };

export class SyncService {
  private readonly activeDeviceIds = new Set<string>();

  constructor(private readonly attendance: AttendanceRepository, private readonly syncRuns: SyncRepository, private readonly clients: DeviceClientFactory,
    private readonly onSynced?: () => Promise<unknown>,
    private readonly onAttendanceUsers?: (deviceId: string, userIds: string[]) => Promise<void>) {}

  async sync(device: Device): Promise<SyncRun> {
    return this.withDeviceLock(device, async () => {
      const run = await this.syncRuns.start(device.id);
      let received = 0;
      let inserted = 0;
      try {
        const events = await this.clients.getClient(device).getAttendance(device);
        received = events.length;
        await this.onAttendanceUsers?.(device.id, events.map((event) => event.userId));
        if (this.attendance.insertBatchIfNew) inserted = await this.attendance.insertBatchIfNew(device.id, events);
        else for (const event of events) if (await this.attendance.insertIfNew(device.id, event)) inserted += 1;
        await this.onSynced?.();
        return await this.syncRuns.finish(run.id, 'succeeded', { received: events.length, inserted });
      } catch (error) {
        try { await this.syncRuns.finish(run.id, 'failed', { received, inserted }, errorMessage(error)); }
        catch (recordingError) { throw new AggregateError([error, recordingError], 'Falló la sincronización y no se pudo registrar el resultado.'); }
        throw error;
      }
    });
  }

  async withDeviceLock<T>(device: Device, operation: () => Promise<T>): Promise<T> {
    if (this.activeDeviceIds.has(device.id)) throw new SyncAlreadyRunningError(`El reloj ${device.name} tiene una operación activa. Intenta nuevamente cuando termine.`);
    this.activeDeviceIds.add(device.id);
    try {
      return await operation();
    } finally {
      this.activeDeviceIds.delete(device.id);
    }
  }
}
