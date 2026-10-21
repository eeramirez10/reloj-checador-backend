import type { SyncRun, SyncType } from '../entities/sync-run.js';

export interface SyncRepository {
  start(deviceId: string, syncType?: SyncType): Promise<SyncRun>;
  finish(id: string, status: 'succeeded' | 'failed', counts: { received: number; inserted: number }, errorMessage?: string): Promise<SyncRun>;
  list(deviceId?: string): Promise<SyncRun[]>;
}
