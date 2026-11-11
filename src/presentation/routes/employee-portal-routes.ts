import type { FastifyInstance } from 'fastify';
import type { ApplicationServices } from '../services.js';
import { AppError } from '../../domain/errors/app-error.js';
import { selfContactSchema } from '../validators/employee-contact.js';
import { leaveCreateSchema, leaveInputSchema } from '../validators/leave.js';
import { employeeAttendanceQuerySchema } from '../validators/employee-attendance.js';
import { formatDateTimeInTimeZone } from '../../domain/entities/attendance-summary.js';
import { idParams } from '../validators/common.js';
import { employeeAccessSchema } from '../validators/auth.js';

export function registerEmployeePortalRoutes(app: FastifyInstance, services: ApplicationServices) {
  const { access,portal,employeeAttendance,leave } = services;
  const employeeId = () => {
    const id = access.current()?.employeeId;
    if (!id) throw new AppError('Tu cuenta no está vinculada a un empleado.', 'FORBIDDEN');
    return id;
  };
  app.get('/blood-types', () => portal.bloodTypes());
  app.get('/manager-options', () => portal.managers());
  app.get('/employees/:id/contact', request => services.contacts.get(idParams.parse(request.params).id));
  app.get('/employees/:id/access', request => portal.access(idParams.parse(request.params).id));
  app.post('/employees/:id/access', request => {
    const input = employeeAccessSchema.parse(request.body);
    return services.employeeAccess.execute(idParams.parse(request.params).id,input.username,access.current()!,input);
  });
  app.get('/me/profile', () => portal.profile(employeeId()));
  app.put('/me/contact', request => portal.saveContact(employeeId(),selfContactSchema.parse(request.body),access.current()!.id));
  app.get('/me/attendance/today', async () => {
    const profile = await portal.profile(employeeId());
    const today = formatDateTimeInTimeZone(new Date(),profile.timeZone).slice(0,10);
    return employeeAttendance.execute(employeeId(),{ from: today,to: today });
  });
  app.get('/me/attendance/card', request => employeeAttendance.execute(employeeId(),employeeAttendanceQuerySchema.parse(request.query)));
  app.post('/me/leave-requests/preview', request => leave.preview(leaveInputSchema.parse({ ...(request.body as object),employeeId: employeeId() })));
  app.post('/me/leave-requests', async (request,reply) => {
    const body = request.body as { input?: object };
    const parsed = leaveCreateSchema.parse({ ...body,input: { ...body.input,employeeId: employeeId() } });
    return reply.code(201).send(await leave.create(parsed.input,parsed.previewToken,parsed.sourceKey));
  });
}
