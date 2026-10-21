import type { Queryable } from '../db/database.js';

export interface DeviceUserPhoto {
  deviceId: string;
  userId: string;
  contentType: 'image/jpeg';
  imageData: Buffer;
  updatedAt: Date;
}

type DeviceUserPhotoRow = {
  device_id: string;
  device_user_id: string;
  content_type: 'image/jpeg';
  image_data: Buffer;
  updated_at: Date;
};

const mapRow = (row: DeviceUserPhotoRow): DeviceUserPhoto => ({
  deviceId: row.device_id,
  userId: row.device_user_id,
  contentType: row.content_type,
  imageData: row.image_data,
  updatedAt: row.updated_at
});

export class DeviceUserPhotoRepository {
  constructor(private readonly database: Queryable) {}

  async upsert(deviceId: string, userId: string, imageData: Buffer): Promise<void> {
    await this.database.query(
      `INSERT INTO device_user_photos (device_id, device_user_id, content_type, image_data)
       VALUES ($1, $2, 'image/jpeg', $3)
       ON CONFLICT (device_id, device_user_id) DO UPDATE SET
         content_type = EXCLUDED.content_type, image_data = EXCLUDED.image_data, updated_at = NOW()`,
      [deviceId, userId, imageData]
    );
  }

  async findByUserId(deviceId: string, userId: string): Promise<DeviceUserPhoto | undefined> {
    const result = await this.database.query<DeviceUserPhotoRow>(
      `SELECT device_id, device_user_id, content_type, image_data, updated_at
       FROM device_user_photos WHERE device_id = $1 AND device_user_id = $2`,
      [deviceId, userId]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }
}
