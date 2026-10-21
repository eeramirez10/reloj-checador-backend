import type { Device } from '../../devices/device-repository.js';
import type { DeviceInfo, ZktecoAttendanceEvent, ZktecoDeviceClient, ZktecoUser } from './types.js';

/** Calls a Windows-only service that wraps ZKTeco's official DLL SDK. */
export class SdkBridgeClient implements ZktecoDeviceClient {
  constructor(private readonly baseUrl: string) {}

  async testConnection(device: Device): Promise<DeviceInfo> {
    return this.request<DeviceInfo>('/devices/test-connection', device);
  }

  async getAttendance(device: Device): Promise<ZktecoAttendanceEvent[]> {
    const records = await this.request<Array<Omit<ZktecoAttendanceEvent, 'occurredAt'> & { occurredAt: string }>>('/devices/attendance', device);
    return records.map((record) => ({ ...record, occurredAt: new Date(record.occurredAt) }));
  }

  async getUsers(device: Device): Promise<ZktecoUser[]> {
    return this.request<ZktecoUser[]>('/devices/users', device);
  }

  private async request<T>(path: string, device: Device): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ipAddress: device.ipAddress, tcpPort: device.tcpPort })
    });
    if (!response.ok) throw new Error(`SDK bridge respondió ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
}
