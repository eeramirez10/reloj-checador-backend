import type { FastifyInstance } from 'fastify';
import type { ApplicationServices } from '../services.js';
import { idParams } from '../validators/common.js';
import { companySchema } from '../validators/company.js';
import { z } from 'zod';

export function registerCompanyRoutes(app: FastifyInstance, { companies }: Pick<ApplicationServices,'companies'>) {
  app.get('/companies',() => companies.list());
  app.post('/companies',async (request,reply) => reply.code(201).send(await companies.save(companySchema.parse(request.body))));
  app.patch('/companies/:id',request => {
    const { expectedVersion,...input } = companySchema.extend({ expectedVersion: z.number().int().min(1) }).parse(request.body);
    return companies.save(input,idParams.parse(request.params).id,expectedVersion);
  });
}
