import type { FastifyInstance } from 'fastify';
import type { ApplicationServices } from '../services.js';
import { idParams } from '../validators/common.js';
import { leaveCreateSchema, leaveFiltersSchema, leaveInputSchema, leaveProfileSchema, leaveResolutionSchema } from '../validators/leave.js';
import { leaveCapabilities } from '../../domain/entities/leave-access.js';

export function registerLeaveRoutes(app: FastifyInstance, { leave, access }: Pick<ApplicationServices, 'leave' | 'access'>) {
  app.get('/leave-requests', async (request) => leave.list(leaveFiltersSchema.parse(request.query)));
  app.post('/leave-requests/preview', async (request) => leave.preview(leaveInputSchema.parse(request.body)));
  app.post('/leave-requests', async (request, reply) => {
    const { input, previewToken, sourceKey } = leaveCreateSchema.parse(request.body);
    return reply.code(201).send(await leave.create(input, previewToken, sourceKey));
  });
  app.get('/leave-requests/:id', async (request) => {
    const detail = await leave.detail(idParams.parse(request.params).id);
    return { ...detail, capabilities: leaveCapabilities(access.current()!, detail.request) };
  });
  app.post('/leave-requests/:id/resolve', async (request) => leave.resolve(idParams.parse(request.params).id, leaveResolutionSchema.parse(request.body), access.current()!));
  app.get('/employees/:id/leave-profile', async (request) => leave.profile(idParams.parse(request.params).id));
  app.put('/employees/:id/leave-profile', async (request) => leave.saveProfile(idParams.parse(request.params).id, leaveProfileSchema.parse(request.body)));
}
