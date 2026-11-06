import { formatDateTimeInTimeZone } from './attendance-summary.js';
import { ConfigurationError, ExternalServiceError } from '../errors/app-error.js';

export interface ClockTimeReading { localTime: string; measuredAt: string }
export interface ClockTimeTarget { localTime: string; sentAt: string }
export interface ClockTimeSnapshot extends ClockTimeReading { timeZone: string; referenceLocalTime: string; driftSeconds: number }
export type ClockAdjustmentRequest = { mode: 'server' } | { mode: 'manual'; localTime: string };
export interface ClockAdjustment {
  id: string; deviceId: string; timeZone: string; status: 'running' | 'succeeded' | 'failed';
  mode: 'server' | 'manual'; requestedLocalTime: string | null;
  before: ClockTimeSnapshot | null; target: ClockTimeTarget | null; after: ClockTimeSnapshot | null;
  error: string | null; startedAt: string; completedAt: string | null;
}
export type ClockAdjustmentPatch = Partial<Pick<ClockAdjustment, 'before' | 'target' | 'after' | 'error'>> & { status?: 'succeeded' | 'failed' };
export const clockVerificationToleranceSeconds = 5;

export function clockWallTimeMilliseconds(value: string): number {
  const timestamp = Date.parse(value.replace(' ', 'T') + 'Z');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) || !Number.isFinite(timestamp)
    || new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ') !== value) {
    throw new ExternalServiceError('El reloj devolvió una fecha u hora inválida.');
  }
  return timestamp;
}

export function clockTimeSnapshot(reading: ClockTimeReading, timeZone: string): ClockTimeSnapshot {
  const measuredAt = new Date(reading.measuredAt);
  if (!Number.isFinite(measuredAt.getTime())) throw new ExternalServiceError('La medición del reloj no contiene una fecha válida.');
  const referenceLocalTime = formatDateTimeInTimeZone(measuredAt, timeZone);
  const driftSeconds = Math.round((clockWallTimeMilliseconds(reading.localTime) - clockWallTimeMilliseconds(referenceLocalTime)) / 1000);
  return { ...reading, timeZone, referenceLocalTime, driftSeconds };
}

export function validateManualClockTime(localTime: string): void {
  try {
    const timestamp = clockWallTimeMilliseconds(localTime);
    const year = new Date(timestamp).getUTCFullYear();
    if (year >= 2000 && year <= 2099) return;
  } catch { /* La entrada del usuario se comunica como error de configuración. */ }
  throw new ConfigurationError('Captura una fecha y hora local válida entre 2000 y 2099, con formato AAAA-MM-DD HH:mm:ss.');
}

export function manualClockDifferenceSeconds(target: ClockTimeTarget, reading: ClockTimeReading): number {
  const elapsed = Date.parse(reading.measuredAt) - Date.parse(target.sentAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new ExternalServiceError('No se pudo determinar el tiempo transcurrido durante la verificación.');
  return Math.round((clockWallTimeMilliseconds(reading.localTime) - clockWallTimeMilliseconds(target.localTime) - elapsed) / 1000);
}
