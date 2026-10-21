import type { Device } from '../../../domain/entities/device.js';
import type { DeviceInfo, ZktecoAttendanceEvent, ZktecoDeviceClient, ZktecoUser } from '../../../domain/datasources/device-client.js';
import { ExternalServiceError, errorMessage } from '../../../domain/errors/app-error.js';

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
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ipAddress: device.ipAddress, tcpPort: device.tcpPort }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new ExternalServiceError(`SDK bridge respondió ${response.status}: ${await response.text()}`);
      return await response.json() as T;
    } catch (error) {
      if (error instanceof ExternalServiceError) throw error;
      throw new ExternalServiceError(`No se pudo conectar con el puente SDK: ${errorMessage(error)}`, 'EXTERNAL_SERVICE_UNAVAILABLE', { cause: error });
    }
  }
}
