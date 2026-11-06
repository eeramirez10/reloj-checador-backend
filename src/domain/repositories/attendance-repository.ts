import type { ZktecoAttendanceEvent } from '../datasources/device-client.js';
import type { AttendanceLog } from '../entities/attendance.js';
import type { AttendanceFilters } from '../dtos/filters.js';

export interface AttendanceRepository {
  insertIfNew(deviceId: string, event: ZktecoAttendanceEvent): Promise<boolean>;
  insertBatchIfNew?(deviceId: string, events: ZktecoAttendanceEvent[]): Promise<number>;
  list(filters: AttendanceFilters): Promise<AttendanceLog[]>;
}
