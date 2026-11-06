import type { DeviceClockDatasource } from '../../domain/datasources/device-clock-datasource.js';
import type { ClockAdjustmentPatch, ClockAdjustmentRequest } from '../../domain/entities/device-clock.js';
import type { DeviceClockRepository } from '../../domain/repositories/device-clock-repository.js';

export class DeviceClockRepositoryImpl implements DeviceClockRepository {
  constructor(private readonly datasource: DeviceClockDatasource) {}
  start(deviceId: string, timeZone: string, request: ClockAdjustmentRequest) { return this.datasource.start(deviceId, timeZone, request); }
  save(id: string, patch: ClockAdjustmentPatch) { return this.datasource.save(id, patch); }
  history(deviceId: string) { return this.datasource.history(deviceId); }
}
