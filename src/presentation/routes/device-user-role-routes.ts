import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApplicationServices } from '../services.js';
import { idParams } from '../validators/common.js';

export function registerDeviceUserRoleRoutes(app: FastifyInstance, services: Pick<ApplicationServices,'deviceUserRole'>) {
  const target = z.object({ clockRecordId: z.string().uuid() }).strict();
  app.get('/employees/:id/clock-role',async (request) => services.deviceUserRole.read(idParams.parse(request.params).id,target.parse(request.query).clockRecordId));
  app.post('/employees/:id/clock-role',async (request) => {
    const input = target.extend({ uid: z.number().int().min(1).max(65535),expectedRole: z.number().int().min(0).max(255),role: z.union([z.literal(0),z.literal(14)]) }).strict().parse(request.body);
    const { clockRecordId,...role } = input;
    return services.deviceUserRole.change(idParams.parse(request.params).id,clockRecordId,role);
  });
  app.get('/employees/:id/clock-role/history',async (request) => services.deviceUserRole.history(idParams.parse(request.params).id));
}
