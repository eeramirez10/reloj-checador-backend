export type SyncType = 'attendance' | 'users' | 'user_photos';
export interface SyncRun {
  id: string; deviceId: string; syncType: SyncType; status: 'running' | 'succeeded' | 'failed';
  startedAt: Date; completedAt?: Date; receivedCount: number; insertedCount: number; errorMessage?: string;
}
