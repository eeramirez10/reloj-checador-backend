import type { Device } from '../devices/device-repository.js';
import type { ZktecoClientFactory } from '../integrations/zkteco/client-factory.js';
import type { SyncRepository, SyncRun } from '../sync/sync-repository.js';
import type { SyncService } from '../sync/sync-service.js';
import type { DeviceUserRepository } from './device-user-repository.js';

export class UserSyncService {
  constructor(
    private readonly users: DeviceUserRepository,
    private readonly syncRuns: SyncRepository,
    private readonly clients: ZktecoClientFactory,
    private readonly attendanceSync: SyncService,
    private readonly onSynced?: () => Promise<unknown>
  ) {}

  async sync(device: Device): Promise<SyncRun> {
    return this.attendanceSync.withDeviceLock(device, async () => {
      const run = await this.syncRuns.start(device.id, 'users');
      try {
        const users = await this.clients.getClient(device).getUsers(device);
        for (const user of users) await this.users.upsert(device.id, user);
        await this.onSynced?.();
        return await this.syncRuns.finish(run.id, 'succeeded', { received: users.length, inserted: users.length });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Error desconocido durante la sincronización de usuarios.';
        await this.syncRuns.finish(run.id, 'failed', { received: 0, inserted: 0 }, message);
        throw error;
      }
    });
  }
}
