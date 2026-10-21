import { describe, expect, it, vi } from 'vitest';
import { SyncAlreadyRunningError, SyncService } from '../src/domain/use-cases/sync-attendance.js';

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

  it('records partial progress and releases the device lock after persistence fails', async () => {
    const device = { id: 'device-1', name: 'Reloj' } as any;
    const event = { userId: '1', occurredAt: new Date(), raw: {} };
    const storageError = new Error('Storage unavailable');
    const insertIfNew = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(storageError).mockResolvedValue(true);
    const finish = vi.fn(async () => ({ id: 'run' }));
    const service = new SyncService({ insertIfNew } as any, { start: async () => ({ id: 'run' }), finish } as any,
      { getClient: () => ({ getAttendance: async () => [event, event] }) } as any);
    await expect(service.sync(device)).rejects.toBe(storageError);
    expect(finish).toHaveBeenCalledWith('run', 'failed', { received: 2, inserted: 1 }, 'Storage unavailable');
    await expect(service.sync(device)).resolves.toMatchObject({ id: 'run' });
  });

  it('preserves the original failure when recording the failed run also fails', async () => {
    const original = { err: { code: 'ECONNREFUSED', message: 'Connection refused' }, command: 'CONNECT' };
    const recording = new Error('Database offline');
    const finish = vi.fn(async () => { throw recording; });
    const service = new SyncService({} as any, { start: async () => ({ id: 'run' }), finish } as any,
      { getClient: () => ({ getAttendance: async () => { throw original; } }) } as any);
    const error = await service.sync({ id: 'device-1' } as any).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([original, recording]);
    expect(finish).toHaveBeenCalledWith('run', 'failed', { received: 0, inserted: 0 }, 'Connection refused');
  });
});
