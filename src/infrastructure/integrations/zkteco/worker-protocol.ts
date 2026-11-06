import type { Device } from '../../../domain/entities/device.js';
import type { DeviceInfo, ZktecoAttendanceEvent, ZktecoUser } from '../../../domain/datasources/device-client.js';
import type { ClockTimeReading, ClockTimeTarget } from '../../../domain/entities/device-clock.js';
import type { DeviceUserRoleInput, DeviceUserRoleResult, DeviceUserRoleSnapshot, DeviceUserRoleTarget } from '../../../domain/entities/device-user-role.js';

export type DeviceOperation = 'testConnection' | 'getAttendance' | 'getUsers' | 'getClockTime' | 'setClockTime' | 'getUserRole' | 'setUserRole';
export type WorkerErrorCode = 'EXTERNAL_SERVICE_ERROR' | 'EXTERNAL_SERVICE_UNAVAILABLE' | 'EXTERNAL_SERVICE_TIMEOUT';
export interface ZktecoWorkerRequest {
  operation: DeviceOperation;
  localTime?: string;
  roleTarget?: DeviceUserRoleTarget | DeviceUserRoleInput;
  device: Device;
  timeoutMs: number;
  operationTimeoutMs: number;
  inPort: number;
}
export type ZktecoWorkerResponse =
  | { type: 'success'; value: DeviceInfo | ZktecoAttendanceEvent[] | ZktecoUser[] | ClockTimeReading | ClockTimeTarget | DeviceUserRoleSnapshot | DeviceUserRoleResult }
  | { type: 'failure'; error: { message: string; code: WorkerErrorCode; stack?: string } };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isWorkerErrorCode(value: unknown): value is WorkerErrorCode {
  return value === 'EXTERNAL_SERVICE_ERROR' || value === 'EXTERNAL_SERVICE_UNAVAILABLE' || value === 'EXTERNAL_SERVICE_TIMEOUT';
}

export function isWorkerRequest(value: unknown): value is ZktecoWorkerRequest {
  if (!isObject(value) || !isObject(value.device)) return false;
  if (value.operation === 'getUserRole' || value.operation === 'setUserRole') {
    const target = value.roleTarget;
    if (!isObject(target) || typeof target.userId !== 'string' || !/^[a-zA-Z0-9_-]{1,24}$/.test(target.userId)
      || !Number.isInteger(target.uid) || Number(target.uid) < 1 || Number(target.uid) > 65535) return false;
    if (value.operation === 'setUserRole' && (target.role !== 0 && target.role !== 14 || !Number.isInteger(target.expectedRole)
      || Number(target.expectedRole) < 0 || Number(target.expectedRole) > 255)) return false;
  } else if (value.roleTarget !== undefined) return false;
  return ['testConnection', 'getAttendance', 'getUsers', 'getClockTime', 'setClockTime', 'getUserRole', 'setUserRole'].includes(String(value.operation))
    && (value.localTime === undefined || (value.operation === 'setClockTime' && typeof value.localTime === 'string'))
    && typeof value.device.id === 'string' && typeof value.device.name === 'string'
    && typeof value.device.ipAddress === 'string' && typeof value.device.tcpPort === 'number'
    && typeof value.timeoutMs === 'number' && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0
    && typeof value.operationTimeoutMs === 'number' && Number.isFinite(value.operationTimeoutMs) && value.operationTimeoutMs > 0
    && typeof value.inPort === 'number' && Number.isInteger(value.inPort);
}

export function isWorkerResponse(value: unknown): value is ZktecoWorkerResponse {
  if (!isObject(value)) return false;
  if (value.type === 'success') return 'value' in value;
  return value.type === 'failure' && isObject(value.error)
    && typeof value.error.message === 'string' && isWorkerErrorCode(value.error.code)
    && (value.error.stack === undefined || typeof value.error.stack === 'string');
}
