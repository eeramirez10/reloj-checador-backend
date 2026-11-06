import type { DeviceClientFactory } from '../datasources/device-client.js';
import type { DeviceOperationLock } from './manage-device-clock.js';
import type { DeviceUserRoleInput } from '../entities/device-user-role.js';
import type { DeviceUserRoleRepository } from '../repositories/device-user-role-repository.js';
import { ConfigurationError, ConflictError } from '../errors/app-error.js';

export class ManageDeviceUserRole {
  constructor(private readonly repository: DeviceUserRoleRepository, private readonly clients: DeviceClientFactory, private readonly lock: DeviceOperationLock) {}

  async read(employeeId: string, clockRecordId: string) {
    const binding = await this.repository.binding(employeeId,clockRecordId);
    const client = this.clients.getClient(binding.device);
    if (!client.getUserRole || binding.device.driver !== 'node') throw new ConfigurationError('Este controlador no admite consultar permisos del reloj.');
    if (binding.uid === null) throw new ConfigurationError('Sincroniza los usuarios del reloj para obtener el UID interno.');
    return this.lock.withDeviceLock(binding.device,async () => {
      const current = await this.repository.binding(employeeId,clockRecordId);
      if (current.uid !== binding.uid || current.userId !== binding.userId || current.device.id !== binding.device.id) throw new ConflictError('El registro del reloj cambió. Actualiza el empleado.');
      const snapshot = await client.getUserRole!(binding.device,{ userId: binding.userId,uid: binding.uid! });
      await this.repository.saveObserved(binding,snapshot);
      return { clockRecordId,snapshot };
    });
  }

  async change(employeeId: string, clockRecordId: string, input: Omit<DeviceUserRoleInput,'userId'>) {
    const binding = await this.repository.binding(employeeId,clockRecordId);
    const client = this.clients.getClient(binding.device);
    if (!client.setUserRole || binding.device.driver !== 'node') throw new ConfigurationError('Este controlador no admite cambiar permisos del reloj.');
    if (binding.uid !== input.uid) throw new ConfigurationError('El UID registrado cambió. Consulta nuevamente el usuario del reloj.');
    return this.lock.withDeviceLock(binding.device,async () => {
      const current = await this.repository.binding(employeeId,clockRecordId);
      if (current.uid !== input.uid || current.userId !== binding.userId || current.device.id !== binding.device.id) throw new ConflictError('El registro del reloj cambió. Consulta nuevamente el usuario.');
      const request = { ...input,userId: binding.userId };
      const run = await this.repository.start(binding,request);
      let result;
      try { result = await client.setUserRole!(binding.device,request); }
      catch {
        result = { status: 'unconfirmed' as const,code: 'COMMUNICATION_FAILED' as const,before: null,after: null,
          error: 'Se perdió la comunicación con el reloj. Consulta el rol antes de intentar otro cambio.' };
      }
      return this.repository.finish(run.id,result);
    });
  }

  history(employeeId: string) { return this.repository.history(employeeId); }
}
