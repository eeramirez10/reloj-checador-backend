import type { Device } from '../entities/device.js';
import type { DeviceClientFactory } from '../datasources/device-client.js';
import type { SyncRepository } from '../repositories/sync-repository.js';
import type { SyncRun } from '../entities/sync-run.js';
import type { SyncService } from './sync-attendance.js';
import type { DeviceUserRepository } from '../repositories/user-repository.js';
import { errorMessage } from '../errors/app-error.js';

export class UserSyncService {
  constructor(
    private readonly users: DeviceUserRepository,
    private readonly syncRuns: SyncRepository,
    private readonly clients: DeviceClientFactory,
    private readonly attendanceSync: SyncService,
    private readonly onSynced?: () => Promise<unknown>
  ) {}

  async sync(device: Device): Promise<SyncRun> {
    return this.attendanceSync.withDeviceLock(device, async () => {
      const run = await this.syncRuns.start(device.id, 'users');
      let received = 0;
      let inserted = 0;
      try {
        const users = await this.clients.getClient(device).getUsers(device);
        received = users.length;
        for (const user of users) { await this.users.upsert(device.id, user); inserted += 1; }
        await this.onSynced?.();
        return await this.syncRuns.finish(run.id, 'succeeded', { received: users.length, inserted: users.length });
      } catch (error) {
        try { await this.syncRuns.finish(run.id, 'failed', { received, inserted }, errorMessage(error)); }
        catch (recordingError) { throw new AggregateError([error, recordingError], 'Falló la sincronización y no se pudo registrar el resultado.'); }
        throw error;
      }
    });
  }
}
