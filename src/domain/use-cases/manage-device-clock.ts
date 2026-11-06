import type { DeviceClientFactory } from '../datasources/device-client.js';
import type { Device } from '../entities/device.js';
import { clockTimeSnapshot, clockVerificationToleranceSeconds, manualClockDifferenceSeconds, validateManualClockTime, type ClockAdjustmentRequest } from '../entities/device-clock.js';
import { ConfigurationError, errorMessage } from '../errors/app-error.js';
import type { DeviceClockRepository } from '../repositories/device-clock-repository.js';

export interface DeviceOperationLock { withDeviceLock<T>(device: Device, operation: () => Promise<T>): Promise<T> }

export class ManageDeviceClock {
  constructor(private readonly repository: DeviceClockRepository, private readonly clients: DeviceClientFactory, private readonly lock: DeviceOperationLock) {}

  private client(device: Device) {
    if (!device.branchId || !device.timeZone) throw new ConfigurationError('Asigna el reloj a una sucursal con zona horaria antes de administrar su hora.');
    const client = this.clients.getClient(device);
    if (!client.getClockTime || !client.setClockTime) throw new ConfigurationError('Este controlador no admite administrar la hora del reloj. Usa TCP/IP directo.');
    return { getClockTime: client.getClockTime.bind(client), setClockTime: client.setClockTime.bind(client) };
  }

  read(device: Device) {
    const client = this.client(device);
    return this.lock.withDeviceLock(device, async () => clockTimeSnapshot(await client.getClockTime(device), device.timeZone!));
  }

  synchronize(device: Device) {
    return this.adjust(device, { mode: 'server' });
  }

  setManually(device: Device, localTime: string) {
    validateManualClockTime(localTime);
    return this.adjust(device, { mode: 'manual', localTime });
  }

  private adjust(device: Device, request: ClockAdjustmentRequest) {
    const client = this.client(device);
    return this.lock.withDeviceLock(device, async () => {
      const run = await this.repository.start(device.id, device.timeZone!, request);
      try {
        const before = clockTimeSnapshot(await client.getClockTime(device), device.timeZone!);
        await this.repository.save(run.id, { before });
        const target = await client.setClockTime(device, request.mode === 'manual' ? request.localTime : undefined);
        await this.repository.save(run.id, { target });
        const after = clockTimeSnapshot(await client.getClockTime(device), device.timeZone!);
        const difference = request.mode === 'manual'
          ? manualClockDifferenceSeconds({ ...target, localTime: request.localTime }, after) : after.driftSeconds;
        const verified = Math.abs(difference) <= clockVerificationToleranceSeconds;
        return await this.repository.save(run.id, { after, status: verified ? 'succeeded' : 'failed',
          error: verified ? null : `El reloj no confirmó la hora esperada; la diferencia es de ${difference} segundos.` });
      } catch (error) {
        try { await this.repository.save(run.id, { status: 'failed', error: errorMessage(error) }); }
        catch (recordingError) { throw new AggregateError([error, recordingError], 'Falló el ajuste de hora y no se pudo registrar su resultado.'); }
        throw error;
      }
    });
  }

  history(deviceId: string) { return this.repository.history(deviceId); }
}
