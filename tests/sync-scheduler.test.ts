import { describe, expect, it, vi } from 'vitest';
import { SyncScheduler } from '../src/infrastructure/jobs/sync-scheduler.js';
import type { Device } from '../src/domain/entities/device.js';
import type { DeviceRepository } from '../src/domain/repositories/device-repository.js';
import type { SyncRun } from '../src/domain/entities/sync-run.js';

const device: Device = { id: 'clock', name: 'Reloj', ipAddress: '127.0.0.1', tcpPort: 4370, driver: 'node', enabled: true,
  syncIntervalSeconds: 60, createdAt: new Date(), updatedAt: new Date() };

function devices(listEnabled: () => Promise<Device[]>): DeviceRepository {
  const unexpected = () => { throw new Error('Operación inesperada.'); };
  return { listEnabled, list: unexpected, findById: unexpected, create: unexpected, update: unexpected, softDelete: unexpected };
}

describe('sync scheduler recovery', () => {
  it('recovers on the next cycle after listing devices fails', async () => {
    const list = vi.fn<() => Promise<Device[]>>().mockRejectedValueOnce(new Error('Database offline')).mockResolvedValue([]);
    const error = vi.fn();
    const scheduler = new SyncScheduler(devices(list), { sync: vi.fn() }, 60, { error });
    await scheduler.syncAll();
    await scheduler.syncAll();
    expect(list).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('isolates a failed clock and logs its identity while other clocks succeed', async () => {
    const sync = vi.fn<(input: Device) => Promise<SyncRun>>()
      .mockRejectedValueOnce(new Error('Clock offline')).mockResolvedValueOnce({ id: 'run' } as SyncRun);
    const error = vi.fn();
    const scheduler = new SyncScheduler(devices(async () => [device, { ...device, id: 'second' }]), { sync }, 60, { error });
    await scheduler.syncAll();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ deviceId: device.id }), expect.any(String));
  });

  it('coalesces overlapping cycles and waits for active work before stopping', async () => {
    let complete!: (result: SyncRun) => void;
    const pending = new Promise<SyncRun>((resolve) => { complete = resolve; });
    const sync = vi.fn(async () => pending);
    const list = vi.fn(async () => [device]);
    const scheduler = new SyncScheduler(devices(list), { sync }, 60, { error: vi.fn() });
    const first = scheduler.syncAll();
    expect(scheduler.syncAll()).toBe(first);
    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    complete({ id: 'run' } as SyncRun);
    await stopping;
    expect(list).toHaveBeenCalledTimes(1);
    expect(stopped).toBe(true);
  });
});
