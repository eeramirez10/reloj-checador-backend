import type { FastifyRequest, FastifyReply } from 'fastify';
import { NotFoundError } from '../../domain/errors/not-found-error.js';
import type { ApplicationServices } from '../services.js';
import { idParams } from '../validators/common.js';
import { assignmentSchema, branchSchema, branchTargetsSchema, policySchema, scheduleSchema, targetSchema } from '../validators/organization.js';

export class OrganizationController {
  constructor(private readonly services: Pick<ApplicationServices, 'organization' | 'evaluation'>) {}

  branches = () => this.services.organization.listBranches();
  policies = () => this.services.organization.listPolicies();
  schedules = () => this.services.organization.listSchedules();
  assignments = () => this.services.organization.listAssignments();

  createBranch = async (request: FastifyRequest, reply: FastifyReply) =>
    reply.code(201).send(await this.services.organization.saveBranch(branchSchema.parse(request.body)));

  updateBranch = async (request: FastifyRequest) => {
    const branch = await this.services.organization.saveBranch(branchSchema.parse(request.body), idParams.parse(request.params).id);
    if (!branch) throw new NotFoundError('Sucursal no encontrada.');
    await this.services.evaluation.recalculate();
    return branch;
  };

  createPolicy = async (request: FastifyRequest, reply: FastifyReply) => {
    const policy = await this.services.organization.addPolicy(idParams.parse(request.params).id, policySchema.parse(request.body));
    await this.services.evaluation.recalculate();
    return reply.code(201).send(policy);
  };

  createSchedule = async (request: FastifyRequest, reply: FastifyReply) => {
    const schedule = await this.services.organization.addSchedule(scheduleSchema.parse(request.body));
    await this.services.evaluation.recalculate();
    return reply.code(201).send(schedule);
  };

  assign = async (request: FastifyRequest, reply: FastifyReply) => {
    await this.services.organization.assign(assignmentSchema.parse(request.body));
    await this.services.evaluation.recalculate();
    return reply.code(204).send();
  };

  assignSchedule = async (request: FastifyRequest, reply: FastifyReply) => {
    await this.services.organization.assignSchedule(idParams.parse(request.params).id, targetSchema.parse(request.body));
    await this.services.evaluation.recalculate();
    return reply.code(204).send();
  };

  assignBranch = async (request: FastifyRequest, reply: FastifyReply) => {
    await this.services.organization.assignBranch(idParams.parse(request.params).id, branchTargetsSchema.parse(request.body));
    await this.services.evaluation.recalculate();
    return reply.code(204).send();
  };
}
