import { describe, expect, it, vi } from 'vitest';
import type { Device } from '../src/devices/device-repository.js';
import type { UserPhotoFile } from '../src/integrations/zkteco/photo-bridge-client.js';
import { UserPhotoSyncService } from '../src/users/user-photo-sync-service.js';

const device: Device = {
  id: 'ffa6b402-8ba2-4bb3-807e-21f84b416713',
  name: 'SilkBio-100TC recepción',
  ipAddress: '192.168.1.199',
  tcpPort: 4370,
  driver: 'node',
  enabled: true,
  syncIntervalSeconds: 60,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function createPhoto(userId: string): UserPhotoFile {
  return { userId, contentType: 'image/jpeg', dataBase64: jpeg.toString('base64') };
}

describe('UserPhotoSyncService', () => {
  it('downloads user photos in batches and reports users without a photo', async () => {
    const users = Array.from({ length: 27 }, (_, index) => ({
      id: `user-row-${index}`,
      deviceId: device.id,
      userId: String(index),
      rawData: {},
      syncedAt: new Date(),
    }));
    const storedUserIds = new Set<string>();
    const batchSizes: number[] = [];
    const finish = vi.fn(async (_runId: string, status: string, counts: { received: number; inserted: number }) => ({
      id: 'run-1',
      deviceId: device.id,
      syncType: 'user_photos',
      status,
      startedAt: new Date(),
      receivedCount: counts.received,
      insertedCount: counts.inserted,
    }));
    const service = new UserPhotoSyncService(
      {
        list: async () => users.map((user) => ({ ...user, hasPhoto: storedUserIds.has(user.userId) })),
      } as any,
      {
        upsert: async (_deviceId: string, userId: string) => { storedUserIds.add(userId); },
      } as any,
      { start: async () => ({ id: 'run-1' }), finish } as any,
      {
        getUserPhotos: async (_device: Device, userIds: string[]) => {
          batchSizes.push(userIds.length);
          return userIds.filter((userId) => userId !== '26').map(createPhoto);
        },
      } as any,
      { withDeviceLock: async (_device: Device, operation: () => Promise<unknown>) => operation() } as any,
    );

    const result = await service.sync(device);

    expect(batchSizes).toEqual([25, 2]);
    expect(result).toMatchObject({ requestedCount: 27, downloadedCount: 26, missingCount: 1 });
    expect(finish).toHaveBeenCalledWith('run-1', 'succeeded', { received: 26, inserted: 26 });
  });

  it('rejects photos for IDs that were not requested and records the failed run', async () => {
    const finish = vi.fn(async (_runId: string, status: string) => ({ id: 'run-1', status }));
    const service = new UserPhotoSyncService(
      { list: async () => [{ id: 'row-1', deviceId: device.id, userId: '12', hasPhoto: false }] } as any,
      { upsert: vi.fn() } as any,
      { start: async () => ({ id: 'run-1' }), finish } as any,
      { getUserPhotos: async () => [createPhoto('other-device-user')] } as any,
      { withDeviceLock: async (_device: Device, operation: () => Promise<unknown>) => operation() } as any,
    );

    await expect(service.sync(device)).rejects.toThrow('foto inesperada');
    expect(finish).toHaveBeenCalledWith('run-1', 'failed', { received: 0, inserted: 0 }, expect.any(String));
  });

  it('rejects non-JPEG bytes before storing them', async () => {
    const upsert = vi.fn();
    const service = new UserPhotoSyncService(
      { list: async () => [{ id: 'row-1', deviceId: device.id, userId: '12', hasPhoto: false }] } as any,
      { upsert } as any,
      { start: async () => ({ id: 'run-1' }), finish: async () => ({ id: 'run-1' }) } as any,
      {
        getUserPhotos: async () => [{ userId: '12', contentType: 'image/jpeg', dataBase64: Buffer.from('not a photo').toString('base64') }],
      } as any,
      { withDeviceLock: async (_device: Device, operation: () => Promise<unknown>) => operation() } as any,
    );

    await expect(service.sync(device)).rejects.toThrow('no es un JPEG válido');
    expect(upsert).not.toHaveBeenCalled();
  });
});
