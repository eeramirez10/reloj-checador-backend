import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/database.js';
import { EmployeeRepository } from '../employees/employee-repository.js';
import type { AttendanceEvaluationService } from '../attendance/attendance-evaluation-service.js';
import type { OrganizationRepository } from './organization-repository.js';
import { branchSchema, dateSchema, policySchema, scheduleSchema, targetSchema } from './schemas.js';
import { personalProfileSchema, socialSecurityNumberSchema, userProfileSchema } from '../users/personal-profile.js';
import { UserProfileRepository } from '../users/user-profile-repository.js';
import { EmployeeRegistry } from '../employees/employee-registry.js';

const idParams = z.object({ id: z.string().uuid() });
const nullableText = z.string().trim().max(200).nullable().optional();
const employeeEditSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(), employeeNumber: z.string().regex(/^\d{8}$/).nullable().optional(),
  position: nullableText, imss: socialSecurityNumberSchema, isActive: z.boolean().optional(),
}).extend(personalProfileSchema.shape).strict();
const reportSchema = z.object({ from: dateSchema, to: dateSchema, branchId: z.string().uuid().optional(), subjectId: z.string().uuid().optional() })
  .refine((value) => value.to >= value.from && (Date.parse(value.to) - Date.parse(value.from)) / 86400000 <= 366, 'El rango debe ser de hasta 366 días.');

export function registerOrganizationRoutes(app: FastifyInstance, dependencies: {
  organization: OrganizationRepository; database: Database; evaluation: AttendanceEvaluationService;
}) {
  const { organization, database, evaluation } = dependencies;
  const profiles = new UserProfileRepository(database);
  const registry = new EmployeeRegistry(database, organization);
  app.get('/employees/:id', async (request, reply) => {
    const employee = await new EmployeeRepository(database).findById(idParams.parse(request.params).id);
    return employee ?? reply.code(404).send({ message: 'Empleado no encontrado.' });
  });
  app.post('/employees', async (request, reply) => {
    const input = personalProfileSchema.extend({ firstName: z.string().trim().min(1).max(150), branchId: z.string().uuid(), position: nullableText }).strict().parse(request.body);
    const id = await registry.create(input);
    return reply.code(201).send(await new EmployeeRepository(database).findById(id));
  });
  app.post('/employees/:id/identify', async (request) => {
    const input = personalProfileSchema.extend({ targetEmployeeId: z.string().uuid().optional(), useAsAssignedClock: z.boolean().default(false) }).strict().parse(request.body);
    const id = await registry.identify(idParams.parse(request.params).id, input);
    await evaluation.recalculate();
    return new EmployeeRepository(database).findById(id);
  });
  app.post('/employees/:id/clock-record', async (request, reply) => {
    const input = z.object({ clockRecordId: z.string().uuid() }).parse(request.body);
    await registry.assignClock(idParams.parse(request.params).id, input.clockRecordId);
    await evaluation.recalculate();
    return reply.code(204).send();
  });
  app.get('/employees/:id/history', async (request) => registry.history(idParams.parse(request.params).id));
  app.get('/branches', async () => organization.listBranches());
  app.post('/branches', async (request, reply) => reply.code(201).send(await organization.saveBranch(branchSchema.parse(request.body))));
  app.put('/branches/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const branch = await organization.saveBranch(branchSchema.parse(request.body), id);
    if (branch) await evaluation.recalculate();
    return branch ?? reply.code(404).send({ message: 'Sucursal no encontrada.' });
  });
  app.get('/branch-policies', async () => organization.listPolicies());
  app.post('/branches/:id/policies', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = policySchema.parse(request.body);
    const policy = await organization.addPolicy(id, input);
    await evaluation.recalculate();
    return reply.code(201).send(policy);
  });
  app.get('/work-schedules', async () => organization.listSchedules());
  app.post('/work-schedules', async (request, reply) => {
    const schedule = await organization.addSchedule(scheduleSchema.parse(request.body));
    await evaluation.recalculate();
    return reply.code(201).send(schedule);
  });
  app.get('/schedule-assignments', async () => organization.listAssignments());
  app.post('/organization/assignments', async (request, reply) => {
    const input = z.object({
      employeeIds: z.array(z.string().uuid()).max(500).default([]), deviceUserIds: z.array(z.string().uuid()).max(500).default([]),
      deviceIds: z.array(z.string().uuid()).max(500).default([]), effectiveFrom: dateSchema,
      branchId: z.string().uuid().optional(), scheduleId: z.string().uuid().nullable().optional(),
    }).refine((value) => value.employeeIds.length + value.deviceUserIds.length + value.deviceIds.length > 0
      && (Boolean(value.branchId) || value.scheduleId !== undefined), 'Selecciona personas y una asignación.')
      .refine((value) => value.deviceIds.length === 0 || (value.employeeIds.length === 0 && value.deviceUserIds.length === 0 && value.scheduleId === undefined), 'Los relojes solo reciben asignaciones de sucursal.').parse(request.body);
    await organization.assign(input);
    await evaluation.recalculate();
    return reply.code(204).send();
  });
  app.post('/work-schedules/:id/assignments', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await organization.assignSchedule(id, targetSchema.parse(request.body));
    await evaluation.recalculate();
    return reply.code(204).send();
  });
  app.post('/branches/:id/assignments', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = z.object({ employeeIds: z.array(z.string().uuid()).max(500).default([]), deviceUserIds: z.array(z.string().uuid()).max(500).default([]),
      deviceIds: z.array(z.string().uuid()).max(500).default([]), effectiveFrom: dateSchema })
      .refine((value) => value.employeeIds.length + value.deviceUserIds.length + value.deviceIds.length > 0).parse(request.body);
    await organization.assignBranch(id, input);
    await evaluation.recalculate();
    return reply.code(204).send();
  });
  app.patch('/employees/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = employeeEditSchema.parse(request.body);
    const { socialSecurityNumber, isActive, ...remaining } = input;
    const fields = Object.fromEntries(Object.entries({ ...remaining, ...(socialSecurityNumber !== undefined ? { imss: socialSecurityNumber } : {}) })
      .filter(([, value]) => value !== undefined)) as Record<string, string | null>;
    if (!await database.transaction((client) => new EmployeeRepository(client).update(id, fields, isActive))) return reply.code(404).send({ message: 'Empleado no encontrado o sin cambios.' });
    await evaluation.recalculate();
    return reply.code(204).send();
  });
  app.patch('/users/:id/profile', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = userProfileSchema.parse(request.body);
    if (!await profiles.update(id, input)) return reply.code(404).send({ message: 'Usuario no encontrado.' });
    await evaluation.recalculate();
    return reply.code(204).send();
  });
  app.get('/attendance/daily', async (request) => evaluation.report(reportSchema.parse(request.query)));
  app.get('/attendance/deductions', async (request) => evaluation.deductions(reportSchema.parse(request.query)));
  app.post('/attendance/recalculate', async () => evaluation.recalculate());
}
