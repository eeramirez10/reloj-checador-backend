import { createHash } from 'node:crypto';
import type { ZktecoAttendanceEvent } from '../../domain/datasources/device-client.js';

export function attendanceEventIdentity(event: ZktecoAttendanceEvent) {
  const raw = event.raw && typeof event.raw === 'object' ? event.raw as Record<string,unknown> : {};
  const localTime = typeof raw.deviceLocalTime === 'string' ? raw.deviceLocalTime : null;
  const legacyKey = event.deviceLogId ?? createHash('sha256')
    .update(JSON.stringify([event.userId,event.occurredAt.toISOString(),event.verificationType,event.punchState])).digest('hex');
  const key = `clock:${createHash('sha256').update(JSON.stringify([
    event.deviceLogId ?? null,event.userId,localTime ?? event.occurredAt.toISOString(),
    ...(event.deviceLogId === undefined ? [event.verificationType ?? null,event.punchState ?? null] : []),
  ])).digest('hex')}`;
  return { key, legacyKey, localTime };
}
