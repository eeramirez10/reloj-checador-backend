import type { CreateDeviceInput, Device } from '../entities/device.js';

export interface DeviceRepository {
  list(): Promise<Device[]>;
  listEnabled(): Promise<Device[]>;
  findById(id: string): Promise<Device | undefined>;
  create(input: CreateDeviceInput): Promise<Device>;
  update(id: string, input: Partial<CreateDeviceInput>): Promise<Device | undefined>;
  softDelete(id: string): Promise<boolean>;
}
