import type { FastifyInstance } from 'fastify';
import type { ApplicationServices } from '../services.js';
import { idParams } from '../validators/common.js';
import { companySchema } from '../validators/company.js';
import { z } from 'zod';
import { companyFilterSchema } from '../validators/company.js';

export function registerCompanyRoutes(app: FastifyInstance, { companies,companyEmployees,assignCompanyEmployees,access }: Pick<ApplicationServices,'companies'|'companyEmployees'|'assignCompanyEmployees'|'access'>) {
  app.get('/companies',() => companies.list());
  app.get('/companies/:id/employees',request=>companyEmployees.candidates(idParams.parse(request.params).id,z.object({
    branchId:z.string().uuid().optional(),companyId:companyFilterSchema,search:z.string().trim().max(120).optional(),
    sortBy:z.enum(['name','branch','company']).default('name'),sortOrder:z.enum(['asc','desc']).default('asc'),
    page:z.coerce.number().int().min(1).default(1),limit:z.coerce.number().int().min(1).max(100).default(25),
  }).strict().parse(request.query),access.current()!));
  app.post('/companies/:id/employees',request=>{
    const input=z.object({expectedVersion:z.number().int().min(1),assignments:z.array(z.object({employeeId:z.string().uuid(),expectedCompanyId:z.string().uuid().nullable()}).strict()).min(1).max(500)}).strict().parse(request.body);
    return assignCompanyEmployees.execute(idParams.parse(request.params).id,input.assignments,input.expectedVersion,access.current()!);
  });
  app.post('/companies',async (request,reply) => reply.code(201).send(await companies.save(companySchema.parse(request.body))));
  app.patch('/companies/:id',request => {
    const { expectedVersion,...input } = companySchema.extend({ expectedVersion: z.number().int().min(1) }).parse(request.body);
    return companies.save(input,idParams.parse(request.params).id,expectedVersion);
  });
}
