import type { Device } from '../devices/device-repository.js';
import { PhotoBridgeError, type UserPhotoFile, type ZktecoPhotoBridgeClient } from '../integrations/zkteco/photo-bridge-client.js';
import type { SyncRepository, SyncRun } from '../sync/sync-repository.js';
import type { SyncService } from '../sync/sync-service.js';
import type { DeviceUserRepository } from './device-user-repository.js';
import type { DeviceUserPhotoRepository } from './device-user-photo-repository.js';

const photoBatchSize = 25;
const maximumPhotoSize = 512 * 1024;
const jpegSignature = Buffer.from([0xff, 0xd8, 0xff]);

export interface UserPhotoSyncResult {
  run: SyncRun;
  requestedCount: number;
  downloadedCount: number;
  missingCount: number;
}

export class UnknownDevicePhotoUsersError extends Error {
  constructor(readonly userIds: string[]) {
    super(`Los usuarios ${userIds.join(', ')} no están registrados en este reloj.`);
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function decodeJpeg(photo: UserPhotoFile): Buffer {
  const maximumBase64Size = 4 * Math.ceil(maximumPhotoSize / 3);
  if (photo.dataBase64.length > maximumBase64Size
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(photo.dataBase64)) {
    throw new PhotoBridgeError(`El puente devolvió una imagen inválida para el usuario ${photo.userId}.`);
  }

  const image = Buffer.from(photo.dataBase64, 'base64');
  if (image.length === 0 || image.length > maximumPhotoSize || !image.subarray(0, 3).equals(jpegSignature)) {
    throw new PhotoBridgeError(`La foto del usuario ${photo.userId} no es un JPEG válido o excede el tamaño permitido.`);
  }
  return image;
}

export class UserPhotoSyncService {
  constructor(
    private readonly users: DeviceUserRepository,
    private readonly photos: DeviceUserPhotoRepository,
    private readonly syncRuns: SyncRepository,
    private readonly photoBridge: ZktecoPhotoBridgeClient,
    private readonly attendanceSync: SyncService
  ) {}

  async sync(device: Device, selectedUserIds?: string[]): Promise<UserPhotoSyncResult> {
    return this.attendanceSync.withDeviceLock(device, async () => {
      const users = await this.users.list({ deviceId: device.id, limit: 10_000 });
      const registeredUserIds = new Set(users.map((user) => user.userId));
      const userIds = selectedUserIds ?? [...registeredUserIds];
      const requestedUserIds = new Set(userIds);
      const unknownUserIds = userIds.filter((userId) => !registeredUserIds.has(userId));
      if (unknownUserIds.length > 0) throw new UnknownDevicePhotoUsersError(unknownUserIds);

      const run = await this.syncRuns.start(device.id, 'user_photos');
      let requestedCount = 0;
      let downloadedCount = 0;
      let storedCount = 0;
      try {
        requestedCount = userIds.length;
        const downloadedUserIds = new Set<string>();

        for (const batch of chunks(userIds, photoBatchSize)) {
          const photos = await this.photoBridge.getUserPhotos(device, batch);
          for (const photo of photos) {
            if (!requestedUserIds.has(photo.userId) || downloadedUserIds.has(photo.userId)) {
              throw new PhotoBridgeError(`El puente devolvió una foto inesperada para el usuario ${photo.userId}.`);
            }

            const image = decodeJpeg(photo);
            await this.photos.upsert(device.id, photo.userId, image);
            downloadedUserIds.add(photo.userId);
            downloadedCount += 1;
            storedCount += 1;
          }
        }

        const syncedUsers = await this.users.list({ deviceId: device.id, limit: 10_000 });
        const finishedRun = await this.syncRuns.finish(run.id, 'succeeded', {
          received: downloadedCount,
          inserted: storedCount
        });
        return {
          run: finishedRun,
          requestedCount,
          downloadedCount,
          missingCount: syncedUsers.filter((user) => !user.hasPhoto).length
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Error desconocido durante la sincronización de fotos.';
        await this.syncRuns.finish(run.id, 'failed', { received: downloadedCount, inserted: storedCount }, message);
        throw error;
      }
    });
  }
}
