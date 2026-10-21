import type { FastifyInstance } from 'fastify';
import type { ApplicationServices } from '../services.js';
import { EmployeeController } from '../controllers/employee-controller.js';
import { OrganizationController } from '../controllers/organization-controller.js';
import { AttendanceController } from '../controllers/attendance-controller.js';

export function registerOrganizationRoutes(app: FastifyInstance, services: ApplicationServices): void {
  const employees = new EmployeeController(services);
  const organization = new OrganizationController(services);
  const attendance = new AttendanceController(services);
  app.get('/employees/:id', employees.find);
  app.post('/employees', employees.create);
  app.post('/employees/:id/identify', employees.identify);
  app.post('/employees/:id/clock-record', employees.assignClock);
  app.get('/employees/:id/history', employees.history);
  app.patch('/employees/:id', employees.update);
  app.patch('/users/:id/profile', employees.updateProfile);
  app.get('/branches', organization.branches);
  app.post('/branches', organization.createBranch);
  app.put('/branches/:id', organization.updateBranch);
  app.get('/branch-policies', organization.policies);
  app.post('/branches/:id/policies', organization.createPolicy);
  app.get('/work-schedules', organization.schedules);
  app.post('/work-schedules', organization.createSchedule);
  app.get('/schedule-assignments', organization.assignments);
  app.post('/organization/assignments', organization.assign);
  app.post('/work-schedules/:id/assignments', organization.assignSchedule);
  app.post('/branches/:id/assignments', organization.assignBranch);
  app.get('/attendance/daily', attendance.daily);
  app.get('/attendance/deductions', attendance.deductions);
  app.post('/attendance/recalculate', attendance.recalculate);
}
