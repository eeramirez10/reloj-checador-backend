import type { ZktecoUser } from '../datasources/device-client.js';
import type { DeviceUser, DeviceUserPhoto } from '../entities/device-user.js';
import type { UserProfilePatch } from '../entities/personal-profile.js';

export interface DeviceUserRepository {
  ensureFromAttendance(deviceId: string, userIds: string[]): Promise<void>;
  upsert(deviceId: string, user: ZktecoUser): Promise<void>;
  list(filters: { deviceId?: string; limit: number }): Promise<DeviceUser[]>;
}
export interface DeviceUserPhotoRepository {
  upsert(deviceId: string, userId: string, imageData: Buffer): Promise<void>;
  findByUserId(deviceId: string, userId: string): Promise<DeviceUserPhoto | undefined>;
}
export interface UserProfileRepository { update(id: string, input: UserProfilePatch): Promise<boolean> }
