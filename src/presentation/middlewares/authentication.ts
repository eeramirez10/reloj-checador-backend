import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parse } from 'cookie';
import type { ApplicationServices } from '../services.js';
import { AppError } from '../../domain/errors/app-error.js';
import type { AccessResource, AuthPrincipal } from '../../domain/entities/auth.js';

const readRoutes = new Set([
  '/companies',
  '/devices','/devices/:id','/devices/:deviceId/users/:userId/photo','/sync-runs','/users','/employees','/employees/:id',
  '/employees/:id/history','/employees/:id/attendance','/employees/:id/scheduling','/employees/:id/leave-profile',
  '/branches','/branch-policies','/branch-configurations','/branches/:id/configuration','/work-schedules','/schedule-assignments',
  '/attendance','/users/:userId/attendance-summary','/attendance/daily','/attendance/cards','/attendance/cards/export',
  '/attendance/overtime','/attendance/overtime/export','/attendance/deductions','/leave-requests','/leave-requests/:id','/attendance/imports',
]);
const hrWrites = new Set([
  'POST /employees/:id/discard',
  'POST /employees','POST /employees/:id/identify','POST /employees/:id/clock-record','PATCH /employees/:id','PUT /employees/:id/scheduling','PATCH /users/:id/profile',
  'POST /branches/:id/configuration','DELETE /branches/:id/configuration/versions/:versionId','POST /branches/:id/policies','POST /work-schedules',
  'POST /organization/assignments','POST /work-schedules/:id/assignments','POST /branches/:id/assignments',
  'POST /leave-requests/preview','POST /leave-requests','POST /leave-requests/:id/resolve','PUT /employees/:id/leave-profile',
  'POST /attendance/imports/preview','POST /attendance/imports','POST /devices/:id/test-connection',
  'POST /devices/:id/sync-attendance','POST /devices/:id/sync-users','POST /devices/:id/sync-user-photos',
]);
const resourceKeys: Record<string,AccessResource> = {
  branchId: 'branch', deviceId: 'device', employeeId: 'employee', subjectId: 'employee', managerId: 'employee',
  clockRecordId: 'clockRecord', scheduleId: 'schedule', targetEmployeeId: 'employee',
};
const resourceArrays: Record<string,AccessResource> = { employeeIds: 'employee', deviceUserIds: 'clockRecord', deviceIds: 'device' };

function allowed(principal: AuthPrincipal, method: string, route: string): boolean {
  if (route.startsWith('/me/') || (method === 'GET' && route === '/blood-types')) return true;
  if (route === '/leave-requests/:id/resolve' && method === 'POST') return true;
  if (principal.role === 'employee') return method === 'GET' && ['/leave-requests','/leave-requests/:id'].includes(route);
  if(route==='/companies/:id/employees') return ['admin','hr'].includes(principal.role);
  if (route === '/manager-options' || route === '/employees/:id/contact' || route === '/employees/:id/access') return ['admin','hr'].includes(principal.role);
  if (principal.role === 'admin') return true;
  if (method === 'GET' && readRoutes.has(route)) return true;
  return principal.role === 'hr' && hrWrites.has(`${method} ${route}`);
}

async function checkReferences(value: unknown, services: ApplicationServices, editing = false, managerAssignment = false): Promise<void> {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) await checkReferences(item, services, editing, managerAssignment); return; }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'managerId' && managerAssignment) continue;
    if (key === 'branchId' && item === 'unassigned') continue;
    if (resourceKeys[key] && typeof item === 'string') {
      await services.access.assertResource(resourceKeys[key], item);
      if (editing && resourceKeys[key] === 'employee') await services.access.assertEmployeeHistory(item);
    }
    else if (resourceArrays[key] && Array.isArray(item)) {
      if (key === 'deviceIds' && item.length && services.access.current()?.role !== 'admin') throw new AppError('Solo el administrador puede reasignar dispositivos.', 'FORBIDDEN');
      for (const id of item) if (typeof id === 'string') {
        await services.access.assertResource(resourceArrays[key], id);
        if (editing && resourceArrays[key] === 'employee') await services.access.assertEmployeeHistory(id);
      }
    } else if (item && typeof item === 'object') await checkReferences(item, services, editing, managerAssignment);
  }
}

async function authorizeReferences(request: FastifyRequest, route: string, services: ApplicationServices) {
  if (route.startsWith('/me/')) return;
  if(route==='/companies/:id/employees' && request.method==='POST') return;
  const params = request.params as Record<string,string>;
  const contactOnly = route === '/employees/:id' && request.method === 'PATCH' && request.body && Object.keys(request.body).every(key => ['contact','companyId'].includes(key));
  const accessOnly = route === '/employees/:id/access';
  if (params.id) {
    const kind: AccessResource | undefined = route.startsWith('/employees/') ? 'employee' : route.startsWith('/devices/') ? 'device'
      : route.startsWith('/branches/') ? 'branch' : route.startsWith('/work-schedules/') ? 'schedule'
        : route.startsWith('/leave-requests/') ? 'leave' : route.startsWith('/users/') ? 'clockRecord' : undefined;
    if (kind) await services.access.assertResource(kind, params.id);
    if (route === '/employees/:id/history' || route === '/employees/:id/scheduling' || (route.startsWith('/employees/') && request.method !== 'GET' && !contactOnly && !accessOnly)) await services.access.assertEmployeeHistory(params.id);
  }
  await checkReferences(params, services);
  await checkReferences(request.query, services);
  const managerAssignment = route.startsWith('/employees/:id') && ['PUT','PATCH'].includes(request.method) && ['admin','hr'].includes(services.access.current()!.role);
  await checkReferences(request.body, services, route!=='/companies/:id/employees', managerAssignment);
}

export function registerAuthentication(app: FastifyInstance, services: ApplicationServices) {
  const { auth, access, authentication } = services;
  const safeMethods = new Set(['GET','HEAD','OPTIONS']);
  app.addHook('onRequest', (_request, _reply, done) => access.run(done));
  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions.url ?? '';
    reply.header('cache-control', 'no-store');
    if (route === '/health' || route.startsWith('/integrations/twilio/whatsapp/')) return;
    if (!safeMethods.has(request.method) && !authentication.testPrincipal) {
      if (!request.headers.origin || !authentication.origins.includes(request.headers.origin)) throw new AppError('Origen de la solicitud no autorizado.', 'FORBIDDEN');
    }
    if (route === '/auth/login') return;
    const token = parse(request.headers.cookie ?? '')[authentication.secureCookie ? '__Host-reloj_session' : 'reloj_session'];
    const principal = authentication.testPrincipal ?? (token && /^[a-zA-Z0-9_-]{43}$/.test(token) ? await auth.repository.session(auth.tokens.hash(token)) : undefined);
    if (!principal) throw new AppError('Inicia sesión para continuar.', 'UNAUTHORIZED');
    access.set(principal);
    if (principal.mustChangePassword && !['/auth/me','/auth/change-password','/auth/logout'].includes(route)) throw new AppError('Cambia tu contraseña para continuar.', 'FORBIDDEN');
    if (!safeMethods.has(request.method) && !authentication.testPrincipal) {
      const supplied = request.headers['x-csrf-token'];
      if (typeof supplied !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(principal.csrfToken))) throw new AppError('La sesión de seguridad cambió. Actualiza la página.', 'FORBIDDEN');
    }
    if (['/auth/me','/auth/logout','/auth/change-password'].includes(route)) return;
    if (!allowed(principal, request.method, route)) throw new AppError('No tienes permiso para realizar esta acción.', 'FORBIDDEN');
  });
  app.addHook('preHandler', async request => {
    const route = request.routeOptions.url ?? '';
    if (!access.current() || route.startsWith('/auth/') || authentication.testPrincipal) return;
    await authorizeReferences(request, route, services);
  });
  app.addHook('onSend', async (request, reply, payload) => {
    const principal = access.current();
    if (!authentication.testPrincipal && principal && !safeMethods.has(request.method) && reply.statusCode < 400 && !request.routeOptions.url?.startsWith('/auth/')) {
      await auth.repository.audit(principal.id, 'operation', undefined, { requestId: request.id, method: request.method, route: request.routeOptions.url, params: request.params });
    }
    return payload;
  });
}
