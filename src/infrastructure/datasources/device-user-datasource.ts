import { randomUUID } from 'node:crypto';
import type { Queryable } from '../database/database.js';
import type { EmploymentStatus } from '../../domain/entities/employee.js';
import type { DeviceUser } from '../../domain/entities/device-user.js';
import type { ZktecoUser } from '../../domain/datasources/device-client.js';
import type { DeviceUserDatasource } from '../../domain/datasources/persistence.js';

type DeviceUserRow = {
  employee_id: string | null; branch_id: string | null; branch_name: string | null;
  display_name: string | null;
  first_name: string | null; last_name: string | null; rfc: string | null; social_security_number: string | null;
  id: string; device_id: string; device_user_id: string; uid: number | null; name: string | null;
  role: number | null; card_number: string | null; raw_data: Record<string, unknown>; synced_at: Date; has_photo: boolean;
  employee_number: string | null; employee_name: string | null; employee_position: string | null;
  employee_branch_code: string | null; employee_status: EmploymentStatus | null;
};

const mapRow = (row: DeviceUserRow): DeviceUser => ({
  id: row.id, deviceId: row.device_id, userId: row.device_user_id, uid: row.uid ?? undefined,
  name: row.name ?? undefined, role: row.role ?? undefined, cardNumber: row.card_number ?? undefined,
  rawData: row.raw_data, syncedAt: row.synced_at, hasPhoto: row.has_photo,
  employeeNumber: row.employee_number ?? undefined, employeeName: row.employee_name ?? undefined,
  employeePosition: row.employee_position ?? undefined, employeeBranchCode: row.employee_branch_code ?? undefined,
  employeeStatus: row.employee_status ?? undefined, employeeId: row.employee_id ?? undefined,
  branchId: row.branch_id ?? undefined, branchName: row.branch_name ?? undefined, displayName: row.display_name ?? undefined,
  firstName: row.first_name ?? undefined, lastName: row.last_name ?? undefined,
  rfc: row.rfc ?? undefined, socialSecurityNumber: row.social_security_number ?? undefined
});

export class PrismaDeviceUserDatasource implements DeviceUserDatasource {
  constructor(private readonly database: Queryable) {}

  async ensureFromAttendance(deviceId: string, userIds: string[]): Promise<void> {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    const existing = new Set((await this.database.query<{ device_user_id: string }>(
      'SELECT device_user_id FROM device_users WHERE device_id = $1 AND device_user_id = ANY($2::text[])', [deviceId, ids])).rows.map((row) => row.device_user_id));
    for (const userId of ids) if (!existing.has(userId)) await this.upsert(deviceId, { userId, raw: { source: 'attendance' } });
  }

  async upsert(deviceId: string, user: ZktecoUser): Promise<void> {
    await this.database.query(
      `WITH existing AS (SELECT id, employee_id, binding_status FROM device_users WHERE device_id = $2 AND device_user_id = $3),
       candidate AS (
         SELECT e.id FROM employees e JOIN devices d ON d.id = $2 AND d.branch_id = e.branch_id
         WHERE e.normalized_employee_number = COALESCE(NULLIF(LTRIM($3, '0'), ''), '0')
           AND e.identification_status = 'confirmed'
           AND NOT EXISTS (SELECT 1 FROM device_users other WHERE other.employee_id = e.id AND other.binding_status = 'active'
             AND NOT (other.device_id = $2 AND other.device_user_id = $3))
       ), created AS (
         INSERT INTO employees (id, name, branch_id, identification_status, original_name, hire_date)
         SELECT COALESCE((SELECT id FROM existing), $1), COALESCE(NULLIF($5::text, ''), 'Registro ' || $3),
           (SELECT branch_id FROM devices WHERE id = $2), 'pending', COALESCE(NULLIF($5::text, ''), 'Registro ' || $3),
           (NOW() AT TIME ZONE COALESCE((SELECT b.time_zone FROM devices d JOIN branches b ON b.id = d.branch_id WHERE d.id = $2), 'America/Mexico_City'))::date
         WHERE NOT EXISTS (SELECT 1 FROM existing WHERE employee_id IS NOT NULL) AND NOT EXISTS (SELECT 1 FROM candidate)
         RETURNING *
       ), initial_status AS (
         INSERT INTO employee_status_events (id,employee_id,event_type,is_active,local_date,time_zone,original_data)
         SELECT gen_random_uuid(), e.id, 'initial', e.is_active, e.hire_date,
           COALESCE((SELECT b.time_zone FROM devices d JOIN branches b ON b.id = d.branch_id WHERE d.id = $2), 'America/Mexico_City'), to_jsonb(e)
         FROM created e RETURNING id
       ), stored AS (
       INSERT INTO device_users (id, device_id, device_user_id, uid, name, role, card_number, raw_data, branch_id, employee_id, binding_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT branch_id FROM devices WHERE id = $2),
         COALESCE((SELECT employee_id FROM existing), (SELECT id FROM candidate), (SELECT id FROM created)),
         COALESCE((SELECT binding_status FROM existing), 'active'))
       ON CONFLICT (device_id, device_user_id) DO UPDATE SET
          uid = EXCLUDED.uid, name = EXCLUDED.name, role = EXCLUDED.role, card_number = EXCLUDED.card_number,
          employee_id = COALESCE(device_users.employee_id, EXCLUDED.employee_id), raw_data = EXCLUDED.raw_data, synced_at = NOW()
       RETURNING id, employee_id, binding_status)
       INSERT INTO employee_clock_events (id, employee_id, device_user_id, reason)
       SELECT gen_random_uuid(), employee_id, id, 'synchronization' FROM stored
       WHERE binding_status = 'active' AND NOT EXISTS (SELECT 1 FROM existing)`,
      [randomUUID(), deviceId, user.userId, user.uid ?? null, user.name ?? null, user.role ?? null,
        user.cardNumber ?? null, JSON.stringify(user.raw)]
    );
  }

  async list(filters: { deviceId?: string; limit: number }): Promise<DeviceUser[]> {
    const result = await this.database.query<DeviceUserRow>(
       `SELECT u.id, u.device_id, u.device_user_id, u.uid, u.name, u.display_name, u.role, u.card_number, u.raw_data, u.synced_at,
           e.employee_number, e.name AS employee_name, e.position AS employee_position,
           CASE WHEN e.id IS NOT NULL THEN e.first_name ELSE u.first_name END AS first_name,
           CASE WHEN e.id IS NOT NULL THEN e.last_name ELSE u.last_name END AS last_name,
           CASE WHEN e.id IS NOT NULL THEN e.rfc ELSE u.rfc END AS rfc,
           CASE WHEN e.id IS NOT NULL THEN e.imss ELSE u.imss END AS social_security_number,
          e.branch_code AS employee_branch_code, e.id AS employee_id,
          b.id AS branch_id, b.name AS branch_name,
          CASE
            WHEN e.id IS NULL THEN NULL
            WHEN NOT e.is_active THEN 'inactive'
            ELSE 'active'
          END AS employee_status,
          EXISTS (
            SELECT 1 FROM device_user_photos p
            WHERE p.device_id = u.device_id AND p.device_user_id = u.device_user_id
          ) AS has_photo
       FROM device_users u
        LEFT JOIN employees e ON e.id = u.employee_id
        LEFT JOIN devices d ON d.id = u.device_id
        LEFT JOIN branches b ON b.id = COALESCE(e.branch_id, u.branch_id, d.branch_id)
       WHERE ($1::uuid IS NULL OR u.device_id = $1) ORDER BY u.name NULLS LAST, u.device_user_id LIMIT $2`,
      [filters.deviceId ?? null, filters.limit]
    );
    return result.rows.map(mapRow);
  }
}
