import type { Device } from '../../../domain/entities/device.js';
import type { DeviceInfo, ZktecoAttendanceEvent, ZktecoUser } from '../../../domain/datasources/device-client.js';

export type DeviceOperation = 'testConnection' | 'getAttendance' | 'getUsers';
export type WorkerErrorCode = 'EXTERNAL_SERVICE_ERROR' | 'EXTERNAL_SERVICE_UNAVAILABLE' | 'EXTERNAL_SERVICE_TIMEOUT';
export interface ZktecoWorkerRequest {
  operation: DeviceOperation;
  device: Device;
  timeoutMs: number;
  operationTimeoutMs: number;
  inPort: number;
}
export type ZktecoWorkerResponse =
  | { type: 'success'; value: DeviceInfo | ZktecoAttendanceEvent[] | ZktecoUser[] }
  | { type: 'failure'; error: { message: string; code: WorkerErrorCode; stack?: string } };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isWorkerErrorCode(value: unknown): value is WorkerErrorCode {
  return value === 'EXTERNAL_SERVICE_ERROR' || value === 'EXTERNAL_SERVICE_UNAVAILABLE' || value === 'EXTERNAL_SERVICE_TIMEOUT';
}

export function isWorkerRequest(value: unknown): value is ZktecoWorkerRequest {
  if (!isObject(value) || !isObject(value.device)) return false;
  return ['testConnection', 'getAttendance', 'getUsers'].includes(String(value.operation))
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
