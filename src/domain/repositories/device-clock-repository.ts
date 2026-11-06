import type { ClockAdjustment, ClockAdjustmentPatch, ClockAdjustmentRequest } from '../entities/device-clock.js';

export interface DeviceClockRepository {
  start(deviceId: string, timeZone: string, request: ClockAdjustmentRequest): Promise<ClockAdjustment>;
  save(id: string, patch: ClockAdjustmentPatch): Promise<ClockAdjustment>;
  history(deviceId: string): Promise<ClockAdjustment[]>;
}
