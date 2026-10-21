import type { FastifyInstance } from 'fastify';
import type { ApplicationServices } from '../services.js';
import { DeviceController } from '../controllers/device-controller.js';
import { AttendanceController } from '../controllers/attendance-controller.js';
import { EmployeeController } from '../controllers/employee-controller.js';

export function registerCoreRoutes(app: FastifyInstance, services: ApplicationServices): void {
  const devices = new DeviceController(services);
  const attendance = new AttendanceController(services);
  const employees = new EmployeeController(services);

  app.get('/health', { schema: { tags: ['system'] } }, async () => { await services.checkHealth(); return { status: 'ok' }; });
  app.get('/devices', { schema: { tags: ['devices'] } }, devices.list);
  app.get('/devices/:id', { schema: { tags: ['devices'] } }, devices.find);
  app.post('/devices', { schema: { tags: ['devices'] } }, devices.create);
  app.patch('/devices/:id', { schema: { tags: ['devices'] } }, devices.update);
  app.delete('/devices/:id', { schema: { tags: ['devices'] } }, devices.remove);
  app.post('/devices/:id/test-connection', { schema: { tags: ['devices'] } }, devices.testConnection);
  app.post('/devices/:id/sync-attendance', { schema: { tags: ['attendance'] } }, devices.syncAttendance);
  app.post('/devices/:id/sync-users', { schema: { tags: ['users'] } }, devices.syncUsers);
  app.post('/devices/:id/sync-user-photos', { schema: { tags: ['users'] } }, devices.syncPhotos);
  app.get('/devices/:deviceId/users/:userId/photo', { schema: { tags: ['users'] } }, devices.photo);
  app.get('/attendance', { schema: { tags: ['attendance'] } }, attendance.list);
  app.get('/users/:userId/attendance-summary', { schema: { tags: ['attendance'] } }, attendance.summary);
  app.get('/sync-runs', { schema: { tags: ['sync'] } }, devices.syncRuns);
  app.get('/users', { schema: { tags: ['users'] } }, devices.users);
  app.get('/employees', { schema: { tags: ['employees'] } }, employees.list);
}
