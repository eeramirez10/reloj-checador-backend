import { randomUUID } from 'node:crypto';
import type { CreateDeviceInput, Device, DeviceDriver } from '../../domain/entities/device.js';
import type { DeviceDatasource } from '../../domain/datasources/persistence.js';
import type { Queryable } from '../database/database.js';
import type { Prisma } from '../database/generated/client.js';

const include = { branches: { select: { time_zone: true } } } as const;
type DeviceRecord = Prisma.devicesGetPayload<{ include: typeof include }>;

function mapDevice(row: DeviceRecord): Device {
  return {
    id: row.id, name: row.name, ipAddress: row.ip_address, tcpPort: row.tcp_port,
    driver: row.driver as DeviceDriver, enabled: row.enabled, syncIntervalSeconds: row.sync_interval_seconds,
    createdAt: row.created_at, updatedAt: row.updated_at, branchId: row.branch_id ?? undefined,
    timeZone: row.branches?.time_zone,
  };
}

export class PrismaDeviceDatasource implements DeviceDatasource {
  constructor(private readonly database: Queryable) {}

  async list(): Promise<Device[]> {
    return (await this.database.prisma.devices.findMany({ where: { deleted_at: null }, include, orderBy: { name: 'asc' } })).map(mapDevice);
  }

  async listEnabled(): Promise<Device[]> {
    return (await this.database.prisma.devices.findMany({ where: { deleted_at: null, enabled: true }, include, orderBy: { name: 'asc' } })).map(mapDevice);
  }

  async findById(id: string): Promise<Device | undefined> {
    const row = await this.database.prisma.devices.findFirst({ where: { id, deleted_at: null }, include });
    return row ? mapDevice(row) : undefined;
  }

  async create(input: CreateDeviceInput): Promise<Device> {
    return mapDevice(await this.database.prisma.devices.create({
      data: {
        id: randomUUID(), name: input.name, ip_address: input.ipAddress, tcp_port: input.tcpPort,
        driver: input.driver, enabled: input.enabled, sync_interval_seconds: input.syncIntervalSeconds,
        branch_id: input.branchId,
      }, include,
    }));
  }

  async update(id: string, input: Partial<CreateDeviceInput>): Promise<Device | undefined> {
    const result = await this.database.prisma.devices.updateMany({
      where: { id, deleted_at: null },
      data: {
        name: input.name, ip_address: input.ipAddress, tcp_port: input.tcpPort, driver: input.driver,
        enabled: input.enabled, sync_interval_seconds: input.syncIntervalSeconds, updated_at: new Date(),
      },
    });
    return result.count ? this.findById(id) : undefined;
  }

  async softDelete(id: string): Promise<boolean> {
    const now = new Date();
    const result = await this.database.prisma.devices.updateMany({
      where: { id, deleted_at: null }, data: { enabled: false, deleted_at: now, updated_at: now },
    });
    return result.count > 0;
  }
}
