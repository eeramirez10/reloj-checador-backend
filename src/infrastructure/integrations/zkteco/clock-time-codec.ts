import { clockWallTimeMilliseconds } from '../../../domain/entities/device-clock.js';
import { ExternalServiceError } from '../../../domain/errors/app-error.js';

export const clockCommands = { read: 201, write: 202, accepted: 2000 } as const;

export function encodeClockTime(localTime: string): Buffer {
  const date = new Date(clockWallTimeMilliseconds(localTime));
  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2099) throw new ExternalServiceError('El reloj solo admite fechas entre 2000 y 2099.');
  const days = ((year - 2000) * 12 + date.getUTCMonth()) * 31 + date.getUTCDate() - 1;
  const seconds = ((days * 24 + date.getUTCHours()) * 60 + date.getUTCMinutes()) * 60 + date.getUTCSeconds();
  const payload = Buffer.alloc(4); payload.writeUInt32LE(seconds);
  return payload;
}

export function clockCommandPayload(response: unknown): Buffer {
  if (!Buffer.isBuffer(response) || response.length < 8) throw new ExternalServiceError('El reloj devolvió una respuesta de hora incompleta.');
  if (response.readUInt16LE(0) !== clockCommands.accepted) throw new ExternalServiceError('El reloj rechazó el comando de fecha y hora.');
  return response.subarray(8);
}

export function decodeClockTime(payload: Buffer): string {
  if (payload.length !== 4) throw new ExternalServiceError('El reloj devolvió una fecha y hora incompleta.');
  let value = payload.readUInt32LE(0);
  const second = value % 60; value = Math.floor(value / 60);
  const minute = value % 60; value = Math.floor(value / 60);
  const hour = value % 24; value = Math.floor(value / 24);
  const day = value % 31 + 1; value = Math.floor(value / 31);
  const month = value % 12 + 1; const year = Math.floor(value / 12) + 2000;
  const pad = (part: number) => String(part).padStart(2, '0');
  const localTime = `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`;
  clockWallTimeMilliseconds(localTime);
  if (year > 2099) throw new ExternalServiceError('El reloj devolvió un año fuera del intervalo admitido.');
  return localTime;
}
