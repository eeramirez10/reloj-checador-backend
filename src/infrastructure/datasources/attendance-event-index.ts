import type { ZktecoAttendanceEvent } from '../../domain/datasources/device-client.js';
import { attendanceEventIdentity } from './attendance-event-identity.js';

export interface StoredEventIdentity {
  id: string; user_id: string; event_key: string; device_log_id: string | null; occurred_at: Date;
  local_time: string | null; raw_serial: string | null; source: string | null;
}

export class AttendanceEventIndex {
  private readonly identities = new Map<string, number>();
  private readonly imports = new Map<string, StoredEventIdentity[]>();

  constructor(rows: StoredEventIdentity[]) {
    for (const row of rows) {
      this.add(row.user_id, row.occurred_at, row.local_time, row.event_key, row.device_log_id ?? row.raw_serial);
      if (row.source === 'talavie_file' && row.device_log_id === null) {
        const key = this.minuteKey(row.user_id, row.occurred_at);
        this.imports.set(key, [...(this.imports.get(key) ?? []), row]);
      }
    }
  }
  private minuteKey(userId: string, occurredAt: Date) { return JSON.stringify([userId, Math.floor(occurredAt.getTime() / 60000)]); }
  private keys(userId: string, occurredAt: Date, localTime: string | null, eventKey: string, serial: string | null) {
    const times = [['utc', occurredAt.toISOString()], ...(localTime === null ? [] : [['local', localTime]])];
    const identifiers = [['key', eventKey], ...(serial === null ? [] : [['serial', serial]])];
    return times.flatMap(time => identifiers.map(identifier => JSON.stringify([userId, ...time, ...identifier])));
  }
  private add(userId: string, occurredAt: Date, localTime: string | null, eventKey: string, serial: string | null) {
    for (const key of this.keys(userId, occurredAt, localTime, eventKey, serial)) this.identities.set(key, (this.identities.get(key) ?? 0) + 1);
  }
  has(event: ZktecoAttendanceEvent): boolean {
    const identity = attendanceEventIdentity(event);
    return [identity.key, identity.legacyKey].some(key => this.keys(event.userId, event.occurredAt, identity.localTime, key, event.deviceLogId ?? null)
      .some(candidate => this.identities.has(candidate)));
  }
  remember(event: ZktecoAttendanceEvent) {
    const identity = attendanceEventIdentity(event);
    const raw = event.raw && typeof event.raw === 'object' ? event.raw as Record<string,unknown> : {};
    const serial = event.deviceLogId ?? (typeof raw.userSn === 'string' || typeof raw.userSn === 'number' ? String(raw.userSn) : null);
    this.add(event.userId, event.occurredAt, identity.localTime, identity.key, serial);
  }
  takeImport(event: ZktecoAttendanceEvent): string | undefined {
    const key = this.minuteKey(event.userId, event.occurredAt);
    const candidates = this.imports.get(key);
    if (candidates?.length !== 1) return undefined;
    this.imports.delete(key);
    const row = candidates[0];
    for (const identity of this.keys(row.user_id, row.occurred_at, row.local_time, row.event_key, row.device_log_id ?? row.raw_serial)) {
      const remaining = (this.identities.get(identity) ?? 1) - 1;
      if (remaining) this.identities.set(identity, remaining);
      else this.identities.delete(identity);
    }
    return row.id;
  }
}
