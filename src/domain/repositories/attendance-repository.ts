import type { ZktecoAttendanceEvent } from '../datasources/device-client.js';
import type { AttendanceLog } from '../entities/attendance.js';
import type { AttendanceFilters } from '../dtos/filters.js';

export interface AttendanceRepository {
  insertIfNew(deviceId: string, event: ZktecoAttendanceEvent): Promise<boolean>;
  list(filters: AttendanceFilters): Promise<AttendanceLog[]>;
}
