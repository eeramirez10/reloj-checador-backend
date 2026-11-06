import type ZKLib from 'node-zklib';
import type { DeviceUserRoleInput, DeviceUserRoleResult, DeviceUserRoleTarget } from '../../../domain/entities/device-user-role.js';
import { ExternalServiceError } from '../../../domain/errors/app-error.js';
import { decodeRawUsers,findRawUser,userCommandAccepted,userReadRequest,userRecordWithRole,userRoleCommands,userRoleSnapshot } from './user-role-codec.js';

async function readRawUsers(client: ZKLib) {
  const sizes = await client.executeCmd(userRoleCommands.sizes);
  if (!userCommandAccepted(sizes) || sizes.length < 28) throw new ExternalServiceError('No se pudo verificar el número de usuarios del reloj.');
  const count = sizes.readUInt32LE(24);
  const transport = client.connectionType === 'tcp' ? client.zklibTcp : client.connectionType === 'udp' ? client.zklibUdp : null;
  if (!transport) throw new ExternalServiceError('El reloj no tiene un transporte compatible.');
  await client.freeData();
  const event = client.connectionType === 'tcp' ? 'data' : 'message';
  const previous = new Set(transport.socket.listeners(event));
  const closeListeners = new Set(transport.socket.listeners('close'));
  let response;
  try { response = await transport.readWithBuffer(userReadRequest); }
  finally {
    // El SDK deja escuchas de transferencias TCP; se retiran antes del siguiente comando.
    for (const listener of transport.socket.listeners(event)) if (!previous.has(listener)) transport.socket.removeListener(event,listener as (...args: unknown[]) => void);
    for (const listener of transport.socket.listeners('close')) if (!closeListeners.has(listener)) transport.socket.removeListener('close',listener as (...args: unknown[]) => void);
  }
  if (response.err) throw new ExternalServiceError('La descarga del catálogo de usuarios quedó incompleta.');
  const users = decodeRawUsers(response.data,count);
  await client.freeData();
  return users;
}

export async function readDeviceUserRole(client: ZKLib, target: DeviceUserRoleTarget) {
  const users = await readRawUsers(client); return userRoleSnapshot(users,findRawUser(users,target));
}

export async function changeDeviceUserRole(client: ZKLib, input: DeviceUserRoleInput): Promise<DeviceUserRoleResult> {
  let before = null; let after = null; let writeAttempted = false;
  try {
    const users = await readRawUsers(client); const user = findRawUser(users,input); before = userRoleSnapshot(users,user);
    if (user.role !== input.expectedRole) return { status: 'blocked',code: 'STALE_ROLE',before,after,error: 'El rol cambió. Consulta nuevamente el reloj.' };
    if (![0,2,6,14].includes(user.role)) return { status: 'blocked',code: 'UNSUPPORTED_ROLE',before,after,error: 'Este nivel de privilegios requiere revisión del equipo.' };
    if (input.role === 0 && user.role === 14 && before.administratorCount <= 1) return { status: 'blocked',code: 'LAST_ADMIN',before,after,error: 'Primero asigna otro administrador en este reloj.' };
    if (user.role === input.role) return { status: 'succeeded',code: 'VERIFIED',before,after: before,error: null };
    const payload = userRecordWithRole(user,input.role);
    writeAttempted = true;
    if (!userCommandAccepted(await client.executeCmd(userRoleCommands.write,payload))) return { status: 'failed',code: 'WRITE_REJECTED',before,after,error: 'El reloj rechazó el cambio de permisos.' };
    if (!userCommandAccepted(await client.executeCmd(userRoleCommands.refresh))) throw new ExternalServiceError('No se confirmó la actualización de datos.');
    const updated = await readRawUsers(client); const current = findRawUser(updated,input); after = userRoleSnapshot(updated,current);
    const verified = current.role === input.role && current.record.equals(payload) && updated.length === users.length
      && users.every((other) => other.uid === user.uid || updated.some((item) => item.uid === other.uid && item.record.equals(other.record)));
    return { status: verified ? 'succeeded' : 'unconfirmed',code: verified ? 'VERIFIED' : 'NOT_VERIFIED',before,after,
      error: verified ? null : 'El reloj no confirmó el rol solicitado o cambió otros campos. Consulta el equipo antes de intentar otro cambio.' };
  } catch {
    return { status: writeAttempted ? 'unconfirmed' : 'failed',code: 'COMMUNICATION_FAILED',before,after,
      error: writeAttempted ? 'No se confirmó el resultado. Consulta el rol antes de volver a aplicarlo.' : 'No se pudo verificar el catálogo completo y la identidad del usuario. No se envió el cambio.' };
  }
}
