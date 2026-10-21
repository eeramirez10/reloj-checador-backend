import type { DeviceUserPhotoDatasource } from '../../domain/datasources/persistence.js';
import type { DeviceUserPhoto } from '../../domain/entities/device-user.js';
import type { Queryable } from '../database/database.js';

export class PrismaDeviceUserPhotoDatasource implements DeviceUserPhotoDatasource {
  constructor(private readonly database: Queryable) {}

  async upsert(deviceId: string, userId: string, imageData: Buffer): Promise<void> {
    const bytes = new Uint8Array(imageData);
    await this.database.prisma.device_user_photos.upsert({
      where: { device_id_device_user_id: { device_id: deviceId, device_user_id: userId } },
      create: { device_id: deviceId, device_user_id: userId, content_type: 'image/jpeg', image_data: bytes },
      update: { content_type: 'image/jpeg', image_data: bytes, updated_at: new Date() },
    });
  }

  async findByUserId(deviceId: string, userId: string): Promise<DeviceUserPhoto | undefined> {
    const row = await this.database.prisma.device_user_photos.findUnique({
      where: { device_id_device_user_id: { device_id: deviceId, device_user_id: userId } },
    });
    return row ? {
      deviceId: row.device_id, userId: row.device_user_id, contentType: 'image/jpeg',
      imageData: Buffer.from(row.image_data), updatedAt: row.updated_at,
    } : undefined;
  }
}
