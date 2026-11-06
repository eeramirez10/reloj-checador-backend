import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../database/database.js';
import type { EmploymentStatus } from '../../domain/entities/employee.js';
import type { ZktecoAttendanceEvent } from '../../domain/datasources/device-client.js';
import type { AttendanceLog } from '../../domain/entities/attendance.js';
import type { AttendanceDatasource } from '../../domain/datasources/persistence.js';
import { attendanceEventIdentity } from './attendance-event-identity.js';
import { branchScopeSql } from '../security/access-context.js';
import { AttendanceEventIndex, type StoredEventIdentity } from './attendance-event-index.js';

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

export class PrismaAttendanceDatasource implements AttendanceDatasource {
  constructor(private readonly database: Queryable & Partial<Pick<Database,'transaction'>>) {}

  async insertBatchIfNew(deviceId: string, events: ZktecoAttendanceEvent[]): Promise<number> {
    if (!events.length) return 0;
    if (this.database.transaction) return this.database.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))::text', [`attendance-source:${deviceId}`]);
      return new PrismaAttendanceDatasource(client).insertBatchIfNew(deviceId, events);
    });
    const stored = (await this.database.query<StoredEventIdentity>(`SELECT id,user_id,event_key,device_log_id,occurred_at,
      raw_data->>'deviceLocalTime' AS local_time,raw_data->>'userSn' AS raw_serial,raw_data->>'source' AS source
      FROM attendance_logs WHERE device_id=$1 AND user_id=ANY($2::text[])`, [deviceId, [...new Set(events.map(event => event.userId))]])).rows;
    const index = new AttendanceEventIndex(stored);
    const inserts: object[] = [];
    const enrichments: object[] = [];
    for (const event of events) {
      if (index.has(event)) continue;
      const importedId = index.takeImport(event);
      const record = { id: importedId ?? randomUUID(), userId: event.userId, eventKey: attendanceEventIdentity(event).key,
        deviceLogId: event.deviceLogId ?? null, verificationType: event.verificationType ?? null, punchState: event.punchState ?? null,
        occurredAt: event.occurredAt.toISOString(), raw: event.raw };
      (importedId ? enrichments : inserts).push(record);
      index.remember(event);
    }
    for (let offset = 0; offset < enrichments.length; offset += 500) {
      await this.database.query(`UPDATE attendance_logs a SET event_key=x."eventKey",device_log_id=x."deviceLogId",verification_type=x."verificationType",punch_state=x."punchState",
        occurred_at=x."occurredAt",raw_data=x.raw || jsonb_build_object('importEvidence',a.raw_data)
        FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,"eventKey" text,"deviceLogId" text,"verificationType" int,"punchState" int,"occurredAt" timestamptz,raw jsonb)
        WHERE a.device_id=$1 AND a.id=x.id AND a.device_log_id IS NULL AND a.raw_data->>'source'='talavie_file'`,
      [deviceId, JSON.stringify(enrichments.slice(offset, offset + 500))]);
    }
    let inserted = 0;
    for (let offset = 0; offset < inserts.length; offset += 500) {
      const result = await this.database.query(`INSERT INTO attendance_logs(id,device_id,event_key,device_log_id,user_id,verification_type,punch_state,occurred_at,raw_data,branch_id)
        SELECT x.id,$1,x."eventKey",x."deviceLogId",x."userId",x."verificationType",x."punchState",x."occurredAt",x.raw,
          COALESCE((SELECT a.branch_id FROM branch_assignments a JOIN branches b ON b.id=a.branch_id
            WHERE a.device_id=$1 AND a.effective_from <= (x."occurredAt" AT TIME ZONE b.time_zone)::date ORDER BY a.effective_from DESC LIMIT 1),
            (SELECT branch_id FROM devices WHERE id=$1))
        FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,"eventKey" text,"deviceLogId" text,"userId" text,"verificationType" int,"punchState" int,"occurredAt" timestamptz,raw jsonb)
        ON CONFLICT(device_id,event_key) DO NOTHING RETURNING id`, [deviceId, JSON.stringify(inserts.slice(offset, offset + 500))]);
      inserted += result.rows.length;
    }
    return inserted;
  }

  async insertIfNew(deviceId: string, event: ZktecoAttendanceEvent): Promise<boolean> {
    if (this.database.transaction) return this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))::text',[`attendance-source:${deviceId}`]);
      return new PrismaAttendanceDatasource(client).insertIfNew(deviceId,event);
    });
    const identity = attendanceEventIdentity(event);
    const existing = (await this.database.query<{ id: string }>(`SELECT id FROM attendance_logs
      WHERE device_id=$1 AND user_id=$2 AND (event_key=$3 OR event_key=$4 OR (
        $5::text IS NOT NULL AND (device_log_id=$5 OR (device_log_id IS NULL AND raw_data ->> 'userSn'=$5))))
      AND (occurred_at=$6 OR ($7::text IS NOT NULL AND raw_data ->> 'deviceLocalTime'=$7)) LIMIT 1`,
    [deviceId,event.userId,identity.key,identity.legacyKey,event.deviceLogId ?? null,event.occurredAt,identity.localTime])).rows;
    if (existing.length) return false;
    const minute = new Date(Math.floor(event.occurredAt.getTime() / 60_000) * 60_000);
    const imported = (await this.database.query<{ id: string }>(`SELECT id FROM attendance_logs
      WHERE device_id=$1 AND user_id=$2 AND raw_data ->> 'source'='talavie_file' AND device_log_id IS NULL
        AND occurred_at >= $3 AND occurred_at < $3::timestamptz + INTERVAL '1 minute'
      ORDER BY id LIMIT 2`,[deviceId,event.userId,minute])).rows;
    if (imported.length === 1) {
      await this.database.query(`UPDATE attendance_logs SET event_key=$2,device_log_id=$3,verification_type=$4,punch_state=$5,
        occurred_at=$6,raw_data=$7::jsonb || jsonb_build_object('importEvidence',raw_data) WHERE id=$1`,
      [imported[0].id,identity.key,event.deviceLogId ?? null,event.verificationType ?? null,event.punchState ?? null,event.occurredAt,JSON.stringify(event.raw)]);
      return false;
    }
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO attendance_logs (id, device_id, event_key, device_log_id, user_id, verification_type, punch_state, occurred_at, raw_data, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
         COALESCE((SELECT assignment.branch_id FROM branch_assignments assignment JOIN branches b ON b.id = assignment.branch_id
           WHERE assignment.device_id = $2 AND assignment.effective_from <= ($8::timestamptz AT TIME ZONE b.time_zone)::date
           ORDER BY assignment.effective_from DESC LIMIT 1),
           (SELECT branch_id FROM devices WHERE id = $2)))
       ON CONFLICT (device_id, event_key) DO NOTHING
       RETURNING id`,
      [randomUUID(), deviceId, identity.key, event.deviceLogId ?? null, event.userId, event.verificationType ?? null,
         event.punchState ?? null, event.occurredAt, JSON.stringify(event.raw)]
    );
    return result.rows.length === 1;
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
         WHERE (${branchScopeSql('a.branch_id')}) AND ($1::uuid IS NULL OR a.device_id = $1)
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
                AND current_log.user_id = a.user_id AND current_log.occurred_at = a.occurred_at
            )
          )
        ORDER BY a.occurred_at DESC LIMIT $5`,
      [filters.deviceId ?? null, filters.from ?? null, filters.to ?? null, filters.userId ?? null, filters.limit, filters.branchId ?? null]
    );
    return result.rows.map(mapRow);
  }
}
