import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { AppError } from '../domain/errors/app-error.js';
import type { ApplicationServices } from './services.js';
import { registerErrorHandler } from './middlewares/error-handler.js';
import { registerCoreRoutes } from './routes/core-routes.js';
import { registerOrganizationRoutes } from './routes/organization-routes.js';
import { registerLeaveRoutes } from './routes/leave-routes.js';
import { registerWhatsAppRoutes } from './routes/whatsapp-routes.js';
import { registerDeviceUserRoleRoutes } from './routes/device-user-role-routes.js';
import { registerAuthRoutes } from './routes/auth-routes.js';
import { registerAuthentication } from './middlewares/authentication.js';
import { registerEmployeePortalRoutes } from './routes/employee-portal-routes.js';
import { registerCompanyRoutes } from './routes/company-routes.js';

export async function createHttpServer(services: ApplicationServices, normalizeError: (error: unknown) => AppError | undefined) {
  const app = Fastify({ logger: { redact: ['req.headers.cookie','req.headers.authorization','req.headers["x-csrf-token"]','res.headers["set-cookie"]'] } });
  registerErrorHandler(app, normalizeError);
  registerAuthentication(app, services);
  await app.register(helmet);
  await app.register(rateLimit, { global: false });
  await app.register(cors, { origin: false });
  await app.register(swagger, { openapi: { info: { title: 'Reloj Checador API', version: '0.1.0' } } });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  registerAuthRoutes(app, services);
  registerEmployeePortalRoutes(app,services);
  registerCompanyRoutes(app,services);
  registerCoreRoutes(app, services);
  registerOrganizationRoutes(app, services);
  registerLeaveRoutes(app, services);
  registerWhatsAppRoutes(app, services);
  registerDeviceUserRoleRoutes(app, services);
  return app;
}
