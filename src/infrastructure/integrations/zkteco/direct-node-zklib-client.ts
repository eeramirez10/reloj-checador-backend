import ZKLib from 'node-zklib';
import type { Device } from '../../../domain/entities/device.js';
import type { DeviceInfo, ZktecoAttendanceEvent, ZktecoDeviceClient, ZktecoUser } from '../../../domain/datasources/device-client.js';
import { dateAtLocalTime } from '../../../domain/entities/schedule-evaluator.js';
import { ExternalServiceError, errorMessage } from '../../../domain/errors/app-error.js';
import { withTimeout } from '../with-timeout.js';
import { formatDateTimeInTimeZone } from '../../../domain/entities/attendance-summary.js';
import { clockCommandPayload, clockCommands, decodeClockTime, encodeClockTime } from './clock-time-codec.js';
import type { DeviceUserRoleInput, DeviceUserRoleTarget } from '../../../domain/entities/device-user-role.js';
import { changeDeviceUserRole,readDeviceUserRole } from './user-role-client.js';

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

export class DirectNodeZkLibClient implements ZktecoDeviceClient {
  constructor(private readonly timeoutMs: number, private readonly inPort: number, private readonly operationTimeoutMs = timeoutMs) {}

  getUserRole(device: Device, target: DeviceUserRoleTarget) { return this.withClient(device,(client) => readDeviceUserRole(client,target)); }
  setUserRole(device: Device, input: DeviceUserRoleInput) { return this.withClient(device,(client) => changeDeviceUserRole(client,input)); }

  async getClockTime(device: Device) {
    return this.withClient(device, async (client) => {
      const startedAt = Date.now();
      const response = await client.executeCmd(clockCommands.read);
      const measuredAt = new Date(Math.round((startedAt + Date.now()) / 2)).toISOString();
      return { localTime: decodeClockTime(clockCommandPayload(response)), measuredAt };
    });
  }

  async setClockTime(device: Device, manualLocalTime?: string) {
    if (!device.timeZone) throw new ExternalServiceError('El reloj no tiene una zona horaria de sucursal.');
    return this.withClient(device, async (client) => {
      // La hora se calcula después de conectar, no antes de arrancar el proceso aislado.
      const sentAt = new Date().toISOString();
      const localTime = manualLocalTime ?? formatDateTimeInTimeZone(new Date(sentAt), device.timeZone!);
      clockCommandPayload(await client.executeCmd(clockCommands.write, encodeClockTime(localTime)));
      return { localTime, sentAt };
    });
  }

  async testConnection(device: Device): Promise<DeviceInfo> {
    return this.withClient(device, async (client) => {
      const info = await client.getInfo();
      return { raw: info };
    });
  }

  async getAttendance(device: Device): Promise<ZktecoAttendanceEvent[]> {
    return this.withClient(device, async (client) => {
      const response = await client.getAttendances();
      if (response?.err) throw new ExternalServiceError(`El reloj no pudo entregar las checadas: ${errorMessage(response.err)}`);
      if (!Array.isArray(response?.data)) throw new ExternalServiceError('El reloj devolvió una respuesta de checadas inválida.');
      const records: RawAttendance[] = response.data;
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
      if (response?.err) throw new ExternalServiceError(`El reloj no pudo entregar los usuarios: ${errorMessage(response.err)}`);
      if (!Array.isArray(response?.data)) throw new ExternalServiceError('El reloj devolvió una respuesta de usuarios inválida.');
      const users: RawUser[] = response.data;
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

  private async withClient<T>(device: Device, callback: (client: ZKLib) => Promise<T>): Promise<T> {
    const client = new ZKLib(device.ipAddress, device.tcpPort, this.timeoutMs, this.inPort);
    try {
      return await withTimeout((async () => {
        await withTimeout(client.createSocket(), this.timeoutMs,
          `Tiempo de conexión agotado con ${device.name} (${device.ipAddress}:${device.tcpPort}) después de ${this.timeoutMs / 1000} s. El equipo no respondió; revisa el túnel, la ruta y el puerto.`);
        return callback(client);
      })(), this.operationTimeoutMs, `Se agotó el tiempo de comunicación con ${device.name}.`);
    } catch (error) {
      if (error instanceof ExternalServiceError) throw error;
      throw new ExternalServiceError(`No se pudo completar la comunicación con ${device.name}: ${errorMessage(error)}`, 'EXTERNAL_SERVICE_ERROR', { cause: error });
    } finally {
      try { await withTimeout(client.disconnect(), this.timeoutMs, `Se agotó el tiempo de cierre de ${device.name}.`); }
      catch (error) { console.warn(`No se pudo cerrar la conexión con ${device.name}: ${errorMessage(error)}`); }
    }
  }
}
