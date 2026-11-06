import { randomUUID } from 'node:crypto';
import type { SyncRun, SyncType } from '../../domain/entities/sync-run.js';
import type { SyncDatasource } from '../../domain/datasources/persistence.js';
import type { Queryable } from '../database/database.js';
import type { sync_runs as SyncRecord } from '../database/generated/client.js';
import { scopedBranchIds } from '../security/access-context.js';

function mapSyncRun(row: SyncRecord): SyncRun {
  return {
    id: row.id, deviceId: row.device_id, syncType: row.sync_type as SyncType, status: row.status as SyncRun['status'],
    startedAt: row.started_at, completedAt: row.completed_at ?? undefined, receivedCount: row.received_count,
    insertedCount: row.inserted_count, errorMessage: row.error_message ?? undefined,
  };
}

export class PrismaSyncDatasource implements SyncDatasource {
  constructor(private readonly database: Queryable) {}

  async start(deviceId: string, syncType: SyncType = 'attendance'): Promise<SyncRun> {
    return mapSyncRun(await this.database.prisma.sync_runs.create({
      data: { id: randomUUID(), device_id: deviceId, sync_type: syncType, status: 'running' },
    }));
  }

  async finish(id: string, status: 'succeeded' | 'failed', counts: { received: number; inserted: number }, errorMessage?: string): Promise<SyncRun> {
    return mapSyncRun(await this.database.prisma.sync_runs.update({
      where: { id }, data: {
        status, completed_at: new Date(), received_count: counts.received, inserted_count: counts.inserted,
        error_message: errorMessage ?? null,
      },
    }));
  }

  async list(deviceId?: string): Promise<SyncRun[]> {
    const ids = scopedBranchIds();
    return (await this.database.prisma.sync_runs.findMany({
      where: { device_id: deviceId, ...(ids ? { devices: { branch_id: { in: ids } } } : {}) }, orderBy: { started_at: 'desc' }, take: 100,
    })).map(mapSyncRun);
  }
}
