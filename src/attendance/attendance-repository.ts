import { createHash, randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import type { EmploymentStatus } from '../employees/employee-catalog.js';
import type { ZktecoAttendanceEvent } from '../integrations/zkteco/types.js';

export interface AttendanceLog {
  id: string; deviceId: string; deviceLogId?: string; userId: string; verificationType?: number;
  userName?: string; userHasPhoto: boolean; employeeNumber?: string; employeePosition?: string;
  employeeBranchCode?: string; employeeStatus?: EmploymentStatus; punchState?: number;
  occurredAt: Date; rawData: unknown; receivedAt: Date;
  branchId?: string; branchName?: string; employeeId?: string;
}

type AttendanceRow = {
  id: string; device_id: string; device_log_id: string | null; user_id: string; verification_type: number | null;
  punch_state: number | null; occurred_at: Date; raw_data: unknown; received_at: Date; user_name: string | null;
  user_has_photo: boolean;
  employee_number: string | null; employee_name: string | null; employee_position: string | null; employee_branch_code: string | null;
  employee_status: EmploymentStatus | null;
  branch_id: string | null; branch_name: string | null; employee_id: string | null;
};

const mapRow = (row: AttendanceRow): AttendanceLog => ({
  id: row.id, deviceId: row.device_id, deviceLogId: row.device_log_id ?? undefined, userId: row.user_id,
  verificationType: row.verification_type ?? undefined, userName: row.employee_name ?? row.user_name ?? undefined,
  userHasPhoto: row.user_has_photo, punchState: row.punch_state ?? undefined,
  employeeNumber: row.employee_number ?? undefined, employeePosition: row.employee_position ?? undefined,
  employeeBranchCode: row.employee_branch_code ?? undefined, employeeStatus: row.employee_status ?? undefined,
  occurredAt: row.occurred_at, rawData: row.raw_data, receivedAt: row.received_at,
  branchId: row.branch_id ?? undefined, branchName: row.branch_name ?? undefined, employeeId: row.employee_id ?? undefined
});

export class AttendanceRepository {
  constructor(private readonly database: Queryable) {}

  async insertIfNew(deviceId: string, event: ZktecoAttendanceEvent): Promise<boolean> {
    const eventKey = event.deviceLogId ?? createHash('sha256')
      .update(JSON.stringify([event.userId, event.occurredAt.toISOString(), event.verificationType, event.punchState]))
      .digest('hex');
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO attendance_logs (id, device_id, event_key, device_log_id, user_id, verification_type, punch_state, occurred_at, raw_data, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
         COALESCE((SELECT assignment.branch_id FROM branch_assignments assignment JOIN branches b ON b.id = assignment.branch_id
           WHERE assignment.device_id = $2 AND assignment.effective_from <= ($8::timestamptz AT TIME ZONE b.time_zone)::date
           ORDER BY assignment.effective_from DESC LIMIT 1),
           (SELECT branch_id FROM devices WHERE id = $2)))
       ON CONFLICT (device_id, event_key) DO NOTHING
       RETURNING id`,
      [randomUUID(), deviceId, eventKey, event.deviceLogId ?? null, event.userId, event.verificationType ?? null,
         event.punchState ?? null, event.occurredAt, JSON.stringify(event.raw)]
    );
    if (result.rows.length === 1) return true;

    if (event.verificationType !== undefined || event.punchState !== undefined
      || (typeof event.raw === 'object' && event.raw !== null && 'deviceTimeZone' in event.raw)) {
      await this.database.query(
        `UPDATE attendance_logs SET
           device_log_id = COALESCE(device_log_id, $3),
           verification_type = COALESCE(verification_type, $4),
           punch_state = COALESCE(punch_state, $5),
            occurred_at = $6,
            raw_data = $7
         WHERE device_id = $1 AND event_key = $2`,
        [deviceId, eventKey, event.deviceLogId ?? null, event.verificationType ?? null,
          event.punchState ?? null, event.occurredAt, JSON.stringify(event.raw)]
      );
    }

    return false;
  }

  async list(filters: { deviceId?: string; branchId?: string; userId?: string; from?: Date; to?: Date; limit: number }): Promise<AttendanceLog[]> {
    const result = await this.database.query<AttendanceRow>(
       `SELECT a.id, a.device_id, a.device_log_id, a.user_id, a.verification_type, a.punch_state, a.occurred_at,
          a.raw_data, a.received_at, COALESCE(u.display_name, u.name) AS user_name, p.device_user_id IS NOT NULL AS user_has_photo,
          e.employee_number, e.name AS employee_name, e.position AS employee_position,
          e.branch_code AS employee_branch_code, e.id AS employee_id, b.id AS branch_id, b.name AS branch_name,
          CASE
            WHEN e.id IS NULL THEN NULL
            WHEN NOT e.is_active THEN 'inactive'
            ELSE 'active'
          END AS employee_status
       FROM attendance_logs a
       LEFT JOIN device_users u ON u.device_id = a.device_id AND u.device_user_id = a.user_id
       LEFT JOIN device_user_photos p ON p.device_id = a.device_id AND p.device_user_id = a.user_id
        LEFT JOIN employees e ON e.id = u.employee_id
        LEFT JOIN branches b ON b.id = a.branch_id
        WHERE ($1::uuid IS NULL OR a.device_id = $1)
          AND ($2::timestamptz IS NULL OR a.occurred_at >= $2)
          AND ($3::timestamptz IS NULL OR a.occurred_at <= $3)
           AND ($4::text IS NULL OR a.user_id = $4)
           AND ($6::uuid IS NULL OR a.branch_id = $6)
          AND NOT (
            a.device_log_id IS NULL
            AND a.raw_data ? 'userSn'
            AND EXISTS (
              SELECT 1 FROM attendance_logs current_log
              WHERE current_log.device_id = a.device_id
                AND current_log.device_log_id = a.raw_data ->> 'userSn'
            )
          )
        ORDER BY a.occurred_at DESC LIMIT $5`,
      [filters.deviceId ?? null, filters.from ?? null, filters.to ?? null, filters.userId ?? null, filters.limit, filters.branchId ?? null]
    );
    return result.rows.map(mapRow);
  }
}
