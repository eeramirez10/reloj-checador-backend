import ZKLib from 'node-zklib';
import type { Device } from '../../devices/device-repository.js';
import type { DeviceInfo, ZktecoAttendanceEvent, ZktecoDeviceClient, ZktecoUser } from './types.js';
import { dateAtLocalTime } from '../../attendance/schedule-evaluator.js';

function getDeviceLocalTime(value: Date): { date: string; time: string; localTime: string } {
  const pad = (part: number) => String(part).padStart(2, '0');
  const date = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  const time = `${pad(value.getHours())}:${pad(value.getMinutes())}`;
  return { date, time, localTime: `${date} ${time}:${pad(value.getSeconds())}` };
}

type RawAttendance = {
  id?: string | number;
  userSn?: string | number;
  userId?: string | number;
  uid?: string | number;
  deviceUserId?: string | number;
  timestamp?: string | Date;
  recordTime?: string | Date;
  attTime?: string | Date;
  verificationType?: number;
  punchState?: number;
  type?: number;
  state?: number;
  [key: string]: unknown;
};

type RawUser = {
  userId?: string | number;
  uid?: number;
  name?: string;
  role?: number;
  cardno?: string | number;
  password?: string;
  [key: string]: unknown;
};

export class NodeZkLibClient implements ZktecoDeviceClient {
  constructor(private readonly timeoutMs: number, private readonly inPort: number) {}

  async testConnection(device: Device): Promise<DeviceInfo> {
    return this.withClient(device, async (client) => {
      const info = await client.getInfo();
      return { raw: info };
    });
  }

  async getAttendance(device: Device): Promise<ZktecoAttendanceEvent[]> {
    return this.withClient(device, async (client) => {
      const response = await client.getAttendances();
      const records: RawAttendance[] = Array.isArray(response?.data) ? response.data : [];
      return records.map((record) => {
        const timestamp = record.timestamp ?? record.recordTime ?? record.attTime;
        let occurredAt = timestamp instanceof Date ? timestamp : new Date(String(timestamp));
        let localTime: string | undefined;
        // node-zklib interpreta la hora del reloj con la zona del servidor; se reconstruye usando la sucursal.
        if (record.recordTime instanceof Date && timestamp === record.recordTime && device.timeZone && Number.isFinite(occurredAt.getTime())) {
          const wallTime = getDeviceLocalTime(record.recordTime);
          occurredAt = new Date(dateAtLocalTime(wallTime.date, wallTime.time, device.timeZone).getTime()
            + record.recordTime.getSeconds() * 1000 + record.recordTime.getMilliseconds());
          localTime = wallTime.localTime;
        }
        const deviceUserId = record.userId ?? record.uid ?? record.deviceUserId;
        if (deviceUserId === undefined || deviceUserId === '') throw new Error('El reloj devolvió un registro sin identificador de usuario.');
        if (Number.isNaN(occurredAt.getTime())) throw new Error('El reloj devolvió un registro con fecha inválida.');
        return {
          deviceLogId: record.id === undefined
            ? record.userSn === undefined ? undefined : String(record.userSn)
            : String(record.id),
          userId: String(deviceUserId),
          verificationType: typeof record.verificationType === 'number'
            ? record.verificationType
            : typeof record.type === 'number' ? record.type : undefined,
          punchState: typeof record.punchState === 'number'
            ? record.punchState
            : typeof record.state === 'number' ? record.state : undefined,
          occurredAt,
          raw: localTime ? { ...record, deviceLocalTime: localTime, deviceTimeZone: device.timeZone } : record
        };
      });
    });
  }

  async getUsers(device: Device): Promise<ZktecoUser[]> {
    return this.withClient(device, async (client) => {
      const response = await client.getUsers();
      const users: RawUser[] = Array.isArray(response?.data) ? response.data : [];
      return users.map((user) => {
        if (user.userId === undefined || user.userId === '') throw new Error('El reloj devolvió un usuario sin identificador.');
        const name = typeof user.name === 'string' ? user.name.trim() : undefined;
        const raw = {
          userId: String(user.userId),
          ...(typeof user.uid === 'number' ? { uid: user.uid } : {}),
          ...(typeof user.role === 'number' ? { role: user.role } : {}),
          ...(name ? { name } : {}),
          ...(user.cardno !== undefined ? { cardno: String(user.cardno) } : {})
        };
        return {
          userId: String(user.userId),
          uid: typeof user.uid === 'number' ? user.uid : undefined,
          name: name || undefined,
          role: typeof user.role === 'number' ? user.role : undefined,
          cardNumber: user.cardno === undefined ? undefined : String(user.cardno),
          raw
        };
      });
    });
  }

  private async withClient<T>(device: Device, callback: (client: any) => Promise<T>): Promise<T> {
    const client = new ZKLib(device.ipAddress, device.tcpPort, this.timeoutMs, this.inPort);
    await client.createSocket();
    try {
      return await callback(client);
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  }
}
