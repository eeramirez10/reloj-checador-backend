import type { Device } from '../entities/device.js';
import type { ClockTimeReading, ClockTimeTarget } from '../entities/device-clock.js';
import type { DeviceUserRoleInput, DeviceUserRoleResult, DeviceUserRoleSnapshot, DeviceUserRoleTarget } from '../entities/device-user-role.js';

export interface DeviceInfo {
  serialNumber?: string;
  firmwareVersion?: string;
  raw: unknown;
}

export interface ZktecoAttendanceEvent {
  deviceLogId?: string;
  userId: string;
  verificationType?: number;
  punchState?: number;
  occurredAt: Date;
  raw: unknown;
}

export interface ZktecoUser {
  userId: string;
  uid?: number;
  name?: string;
  role?: number;
  cardNumber?: string;
  raw: Record<string, unknown>;
}

export interface ZktecoDeviceClient {
  testConnection(device: Device): Promise<DeviceInfo>;
  getAttendance(device: Device): Promise<ZktecoAttendanceEvent[]>;
  getUsers(device: Device): Promise<ZktecoUser[]>;
  getClockTime?(device: Device): Promise<ClockTimeReading>;
  setClockTime?(device: Device, localTime?: string): Promise<ClockTimeTarget>;
  getUserRole?(device: Device, target: DeviceUserRoleTarget): Promise<DeviceUserRoleSnapshot>;
  setUserRole?(device: Device, input: DeviceUserRoleInput): Promise<DeviceUserRoleResult>;
}

export interface DeviceClientFactory {
  getClient(device: Device): ZktecoDeviceClient;
}

export interface UserPhotoFile { userId: string; contentType: 'image/jpeg'; dataBase64: string }
export interface PhotoClient {
  getUserPhotos(device: Device, userIds: string[]): Promise<UserPhotoFile[]>;
}
