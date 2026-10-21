import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';

export type SyncType = 'attendance' | 'users' | 'user_photos';
export interface SyncRun { id: string; deviceId: string; syncType: SyncType; status: 'running' | 'succeeded' | 'failed'; startedAt: Date; completedAt?: Date; receivedCount: number; insertedCount: number; errorMessage?: string; }
type SyncRunRow = { id: string; device_id: string; sync_type: SyncType; status: SyncRun['status']; started_at: Date; completed_at: Date | null; received_count: number; inserted_count: number; error_message: string | null; };
const selectColumns = 'id, device_id, sync_type, status, started_at, completed_at, received_count, inserted_count, error_message';
const mapRow = (row: SyncRunRow): SyncRun => ({ id: row.id, deviceId: row.device_id, syncType: row.sync_type, status: row.status, startedAt: row.started_at, completedAt: row.completed_at ?? undefined, receivedCount: row.received_count, insertedCount: row.inserted_count, errorMessage: row.error_message ?? undefined });

export class SyncRepository {
  constructor(private readonly database: Queryable) {}

  async start(deviceId: string, syncType: SyncType = 'attendance'): Promise<SyncRun> {
    const result = await this.database.query<SyncRunRow>(
      `INSERT INTO sync_runs (id, device_id, sync_type, status) VALUES ($1, $2, $3, 'running')
       RETURNING ${selectColumns}`, [randomUUID(), deviceId, syncType]
    );
    return mapRow(result.rows[0]);
  }

  async finish(id: string, status: 'succeeded' | 'failed', counts: { received: number; inserted: number }, errorMessage?: string): Promise<SyncRun> {
    const result = await this.database.query<SyncRunRow>(
      `UPDATE sync_runs SET status = $2, completed_at = NOW(), received_count = $3, inserted_count = $4, error_message = $5
       WHERE id = $1 RETURNING ${selectColumns}`,
      [id, status, counts.received, counts.inserted, errorMessage ?? null]
    );
    return mapRow(result.rows[0]);
  }

  async list(deviceId?: string): Promise<SyncRun[]> {
    const result = await this.database.query<SyncRunRow>(
      `SELECT ${selectColumns} FROM sync_runs
       WHERE ($1::uuid IS NULL OR device_id = $1) ORDER BY started_at DESC LIMIT 100`, [deviceId ?? null]
    );
    return result.rows.map(mapRow);
  }
}
