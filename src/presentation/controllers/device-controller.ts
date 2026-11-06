import type { FastifyRequest, FastifyReply } from 'fastify';
import { NotFoundError } from '../../domain/errors/not-found-error.js';
import type { ApplicationServices } from '../services.js';
import { idParams } from '../validators/common.js';
import { createDeviceSchema, deviceSchema, deviceFilterSchema, photoSyncSchema, photoParams, userListSchema } from '../validators/device.js';
import { z } from 'zod';
import { manualClockTimeSchema } from '../validators/device-clock.js';

export class DeviceController {
  constructor(private readonly services: ApplicationServices) {}

  private async device(request: FastifyRequest) {
    const device = await this.services.devices.findById(idParams.parse(request.params).id);
    if (!device) throw new NotFoundError('Dispositivo no encontrado.');
    return device;
  }

  list = async () => {
    await this.services.organization.refreshCurrentBranches();
    return this.services.devices.list();
  };

  find = (request: FastifyRequest) => this.device(request);

  create = async (request: FastifyRequest, reply: FastifyReply) => {
    const input = createDeviceSchema.parse(request.body);
    return reply.code(201).send(await this.services.devices.create({ ...input, driver: input.driver ?? this.services.defaultDriver }));
  };

  update = async (request: FastifyRequest) => {
    const input = deviceSchema.partial().parse(request.body);
    const device = await this.services.devices.update(idParams.parse(request.params).id, input);
    if (!device) throw new NotFoundError('Dispositivo no encontrado.');
    return device;
  };

  remove = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!await this.services.devices.softDelete(idParams.parse(request.params).id)) throw new NotFoundError('Dispositivo no encontrado.');
    return reply.code(204).send();
  };

  testConnection = async (request: FastifyRequest) => {
    const device = await this.device(request);
    return this.services.syncService.withDeviceLock(device, () => this.services.clients.getClient(device).testConnection(device));
  };

  clockTime = async (request: FastifyRequest) => {
    await this.services.organization.refreshCurrentBranches();
    return this.services.deviceClock.read(await this.device(request));
  };

  synchronizeClockTime = async (request: FastifyRequest) => {
    z.object({}).strict().parse(request.body ?? {});
    await this.services.organization.refreshCurrentBranches();
    return this.services.deviceClock.synchronize(await this.device(request));
  };

  clockHistory = async (request: FastifyRequest) => this.services.deviceClock.history((await this.device(request)).id);

  setManualClockTime = async (request: FastifyRequest) => {
    const { localTime } = manualClockTimeSchema.parse(request.body);
    await this.services.organization.refreshCurrentBranches();
    return this.services.deviceClock.setManually(await this.device(request), localTime);
  };

  syncAttendance = async (request: FastifyRequest) => this.services.syncService.sync(await this.device(request));

  syncUsers = async (request: FastifyRequest) => {
    await this.services.organization.refreshCurrentBranches();
    return this.services.userSyncService.sync(await this.device(request));
  };

  syncPhotos = async (request: FastifyRequest) => {
    const device = await this.device(request);
    return this.services.userPhotoSyncService.sync(device, photoSyncSchema.parse(request.body ?? {}).userIds);
  };

  photo = async (request: FastifyRequest, reply: FastifyReply) => {
    const { deviceId, userId } = photoParams.parse(request.params);
    const photo = await this.services.photos.findByUserId(deviceId, userId);
    if (!photo) throw new NotFoundError('El usuario no tiene una foto disponible.');
    return reply.type(photo.contentType).header('cache-control', 'no-store').send(photo.imageData);
  };

  syncRuns = (request: FastifyRequest) => this.services.syncRuns.list(deviceFilterSchema.parse(request.query).deviceId);

  users = async (request: FastifyRequest) => {
    await this.services.organization.refreshCurrentBranches();
    return this.services.users.list(userListSchema.parse(request.query));
  };
}
