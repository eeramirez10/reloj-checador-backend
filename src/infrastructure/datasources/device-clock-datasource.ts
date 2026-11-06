import { randomUUID } from 'node:crypto';
import type { DeviceClockDatasource } from '../../domain/datasources/device-clock-datasource.js';
import type { ClockAdjustment, ClockAdjustmentPatch, ClockAdjustmentRequest } from '../../domain/entities/device-clock.js';
import type { Queryable } from '../database/database.js';

const fields = `id,device_id AS "deviceId",time_zone AS "timeZone",status,mode,requested_local_time AS "requestedLocalTime",before_reading AS before,target,
  after_reading AS after,error,started_at AS "startedAt",completed_at AS "completedAt"`;
type AdjustmentRow = Omit<ClockAdjustment, 'startedAt' | 'completedAt'> & { startedAt: Date; completedAt: Date | null };
const mapRow = (row: AdjustmentRow): ClockAdjustment => ({ ...row, startedAt: row.startedAt.toISOString(), completedAt: row.completedAt?.toISOString() ?? null });

export class PrismaDeviceClockDatasource implements DeviceClockDatasource {
  constructor(private readonly database: Queryable) {}

  async start(deviceId: string, timeZone: string, request: ClockAdjustmentRequest) {
    return mapRow((await this.database.query<AdjustmentRow>(`INSERT INTO device_clock_adjustments (id,device_id,time_zone,mode,requested_local_time)
      VALUES ($1,$2,$3,$4,$5) RETURNING ${fields}`, [randomUUID(), deviceId, timeZone, request.mode, request.mode === 'manual' ? request.localTime : null])).rows[0]);
  }

  async save(id: string, patch: ClockAdjustmentPatch) {
    return mapRow((await this.database.query<AdjustmentRow>(`UPDATE device_clock_adjustments SET
      before_reading=COALESCE($2::jsonb,before_reading),target=COALESCE($3::jsonb,target),after_reading=COALESCE($4::jsonb,after_reading),
      status=COALESCE($5,status),error=$6,completed_at=CASE WHEN $5::text IS NOT NULL THEN NOW() ELSE completed_at END
      WHERE id=$1 RETURNING ${fields}`, [id, patch.before ? JSON.stringify(patch.before) : null,
      patch.target ? JSON.stringify(patch.target) : null, patch.after ? JSON.stringify(patch.after) : null, patch.status ?? null, patch.error ?? null])).rows[0]);
  }

  async history(deviceId: string) {
    return (await this.database.query<AdjustmentRow>(`SELECT ${fields} FROM device_clock_adjustments
      WHERE device_id=$1 ORDER BY started_at DESC,id DESC LIMIT 20`, [deviceId])).rows.map(mapRow);
  }
}
