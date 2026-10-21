import type { FastifyRequest, FastifyReply } from 'fastify';
import { NotFoundError } from '../../domain/errors/not-found-error.js';
import type { ApplicationServices } from '../services.js';
import { idParams } from '../validators/common.js';
import { employeeClockSchema, employeeCreateSchema, employeeEditSchema, employeeIdentifySchema, employeeListSchema } from '../validators/employee.js';
import { userProfileSchema } from '../validators/personal-profile.js';

export class EmployeeController {
  constructor(private readonly services: Pick<ApplicationServices, 'employees' | 'organization' | 'registry' | 'evaluation' | 'updateEmployee' | 'profiles'>) {}

  list = async (request: FastifyRequest) => {
    await this.services.organization.refreshCurrentBranches();
    return this.services.employees.list(employeeListSchema.parse(request.query));
  };

  find = async (request: FastifyRequest) => {
    const employee = await this.services.employees.findById(idParams.parse(request.params).id);
    if (!employee) throw new NotFoundError('Empleado no encontrado.');
    return employee;
  };

  create = async (request: FastifyRequest, reply: FastifyReply) => {
    const id = await this.services.registry.create(employeeCreateSchema.parse(request.body));
    return reply.code(201).send(await this.services.employees.findById(id));
  };

  identify = async (request: FastifyRequest) => {
    const id = await this.services.registry.identify(idParams.parse(request.params).id, employeeIdentifySchema.parse(request.body));
    await this.services.evaluation.recalculate();
    return this.services.employees.findById(id);
  };

  assignClock = async (request: FastifyRequest, reply: FastifyReply) => {
    await this.services.registry.assignClock(idParams.parse(request.params).id, employeeClockSchema.parse(request.body).clockRecordId);
    await this.services.evaluation.recalculate();
    return reply.code(204).send();
  };

  history = (request: FastifyRequest) => this.services.registry.history(idParams.parse(request.params).id);

  update = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = idParams.parse(request.params);
    const { socialSecurityNumber, isActive, ...remaining } = employeeEditSchema.parse(request.body);
    const fields = Object.fromEntries(Object.entries({ ...remaining, ...(socialSecurityNumber !== undefined ? { imss: socialSecurityNumber } : {}) })
      .filter(([, value]) => value !== undefined)) as Record<string, string | null>;
    if (!await this.services.updateEmployee.execute(id, fields, isActive)) throw new NotFoundError('Empleado no encontrado o sin cambios.');
    await this.services.evaluation.recalculate();
    return reply.code(204).send();
  };

  updateProfile = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!await this.services.profiles.update(idParams.parse(request.params).id, userProfileSchema.parse(request.body))) {
      throw new NotFoundError('Usuario no encontrado.');
    }
    await this.services.evaluation.recalculate();
    return reply.code(204).send();
  };
}
