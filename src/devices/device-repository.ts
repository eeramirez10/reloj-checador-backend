import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';

export type DeviceDriver = 'node' | 'sdk-bridge';
export interface Device {
  id: string;
  name: string;
  ipAddress: string;
  tcpPort: number;
  driver: DeviceDriver;
  enabled: boolean;
  syncIntervalSeconds: number;
  createdAt: Date;
  updatedAt: Date;
  branchId?: string;
  timeZone?: string;
}

export interface CreateDeviceInput {
  name: string;
  ipAddress: string;
  tcpPort?: number;
  driver?: DeviceDriver;
  enabled?: boolean;
  syncIntervalSeconds?: number;
  branchId?: string;
}

type DeviceRow = {
  branch_id: string | null;
  time_zone: string | null;
  id: string; name: string; ip_address: string; tcp_port: number; driver: DeviceDriver;
  enabled: boolean; sync_interval_seconds: number; created_at: Date; updated_at: Date;
};

const selectColumns = `id, name, ip_address, tcp_port, driver, enabled, sync_interval_seconds, created_at, updated_at, branch_id,
  (SELECT time_zone FROM branches WHERE id = devices.branch_id) AS time_zone`;
const mapRow = (row: DeviceRow): Device => ({
  id: row.id, name: row.name, ipAddress: row.ip_address, tcpPort: row.tcp_port,
  driver: row.driver, enabled: row.enabled, syncIntervalSeconds: row.sync_interval_seconds,
  createdAt: row.created_at, updatedAt: row.updated_at, branchId: row.branch_id ?? undefined, timeZone: row.time_zone ?? undefined
});

export class DeviceRepository {
  constructor(private readonly database: Queryable) {}

  async list(): Promise<Device[]> {
    const result = await this.database.query<DeviceRow>(`SELECT ${selectColumns} FROM devices WHERE deleted_at IS NULL ORDER BY name`);
    return result.rows.map(mapRow);
  }

  async listEnabled(): Promise<Device[]> {
    const result = await this.database.query<DeviceRow>(`SELECT ${selectColumns} FROM devices WHERE deleted_at IS NULL AND enabled = TRUE ORDER BY name`);
    return result.rows.map(mapRow);
  }

  async findById(id: string): Promise<Device | undefined> {
    const result = await this.database.query<DeviceRow>(`SELECT ${selectColumns} FROM devices WHERE id = $1 AND deleted_at IS NULL`, [id]);
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async create(input: CreateDeviceInput): Promise<Device> {
    const id = randomUUID();
    const result = await this.database.query<DeviceRow>(
      `INSERT INTO devices (id, name, ip_address, tcp_port, driver, enabled, sync_interval_seconds, branch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${selectColumns}`,
      [id, input.name, input.ipAddress, input.tcpPort ?? 4370, input.driver ?? 'node', input.enabled ?? true, input.syncIntervalSeconds ?? 60, input.branchId ?? null]
    );
    return mapRow(result.rows[0]);
  }

  async update(id: string, input: Partial<CreateDeviceInput>): Promise<Device | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const result = await this.database.query<DeviceRow>(
      `UPDATE devices SET name = $2, ip_address = $3, tcp_port = $4, driver = $5, enabled = $6,
        sync_interval_seconds = $7, updated_at = NOW() WHERE id = $1 RETURNING ${selectColumns}`,
      [id, input.name ?? current.name, input.ipAddress ?? current.ipAddress, input.tcpPort ?? current.tcpPort,
        input.driver ?? current.driver, input.enabled ?? current.enabled, input.syncIntervalSeconds ?? current.syncIntervalSeconds]
    );
    return mapRow(result.rows[0]);
  }

  async softDelete(id: string): Promise<boolean> {
    const result = await this.database.query('UPDATE devices SET enabled = FALSE, deleted_at = NOW(), updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
