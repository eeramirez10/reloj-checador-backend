import type { DeviceUserRoleSnapshot, DeviceUserRoleTarget, WritableDeviceUserRole } from '../../../domain/entities/device-user-role.js';
import { ExternalServiceError } from '../../../domain/errors/app-error.js';

export interface RawDeviceUser { uid: number; userId: string; role: number; record: Buffer }
export const userRoleCommands = { sizes: 50,write: 8,refresh: 1013,accepted: 2000 } as const;
export const userReadRequest = Buffer.from([1,9,0,5,0,0,0,0,0,0,0]);

export function decodeRawUsers(data: unknown, count: number): RawDeviceUser[] {
  if (!Buffer.isBuffer(data) || data.length < 4 || !Number.isInteger(count) || count <= 0 || data.readUInt32LE(0) !== data.length-4) {
    throw new ExternalServiceError('El catálogo de usuarios del reloj está incompleto.');
  }
  const size = (data.length-4)/count;
  if (size !== 28 && size !== 72) throw new ExternalServiceError('El formato de usuarios de este reloj no está soportado para cambiar permisos.');
  const users: RawDeviceUser[] = []; const uids = new Set<number>(); const ids = new Set<string>();
  for (let offset=4;offset<data.length;offset+=size) {
    const record = Buffer.from(data.subarray(offset,offset+size));
    const uid = record.readUInt16LE(0);
    const userId = size === 28 ? String(record.readUInt32LE(24)) : record.subarray(48,72).toString('latin1').split('\0')[0];
    if (!uid || !/^[a-zA-Z0-9_-]{1,24}$/.test(userId) || uids.has(uid) || ids.has(userId)) throw new ExternalServiceError('El catálogo contiene identidades de usuario inválidas o duplicadas.');
    uids.add(uid); ids.add(userId); users.push({ uid,userId,role: record.readUInt8(2),record });
  }
  return users;
}

export function findRawUser(users: RawDeviceUser[], target: DeviceUserRoleTarget): RawDeviceUser {
  const user = users.find((item) => item.userId === target.userId && item.uid === target.uid);
  if (!user) throw new ExternalServiceError('El usuario y UID no coinciden con el registro actual del reloj.');
  return user;
}

export function userRoleSnapshot(users: RawDeviceUser[], user: RawDeviceUser): DeviceUserRoleSnapshot {
  return { userId: user.userId,uid: user.uid,role: user.role,administratorCount: users.filter((item) => item.role === 14).length,totalUsers: users.length,measuredAt: new Date().toISOString() };
}

export function userRecordWithRole(user: RawDeviceUser, role: WritableDeviceUserRole): Buffer {
  const record = Buffer.from(user.record); record.writeUInt8(role,2); return record;
}

export function userCommandAccepted(response: unknown): boolean {
  if (!Buffer.isBuffer(response) || response.length < 8) throw new ExternalServiceError('El reloj devolvió una confirmación incompleta.');
  return response.readUInt16LE(0) === userRoleCommands.accepted;
}
