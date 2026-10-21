import { describe, expect, it } from 'vitest';
import { SyncAlreadyRunningError, SyncService } from '../src/sync/sync-service.js';

describe('SyncService', () => {
  it('prevents concurrent syncs for the same device', async () => {
    const device = { id: 'device-1', name: 'Reloj', ipAddress: '192.168.1.2', tcpPort: 4370, driver: 'node' as const, enabled: true, syncIntervalSeconds: 60, createdAt: new Date(), updatedAt: new Date() };
    let resolveAttendance: (() => void) | undefined;
    const attendancePromise = new Promise<void>((resolve) => { resolveAttendance = resolve; });
    const service = new SyncService(
      { insertIfNew: async () => true } as any,
      { start: async () => ({ id: 'run-1' }), finish: async () => ({ id: 'run-1' }) } as any,
      { getClient: () => ({ getAttendance: async () => { await attendancePromise; return []; } }) } as any
    );
    const first = service.sync(device);
    await expect(service.sync(device)).rejects.toBeInstanceOf(SyncAlreadyRunningError);
    resolveAttendance?.();
    await first;
  });
});
