import type { Device } from '../../devices/device-repository.js';

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
}
