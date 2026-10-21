import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import type { AppError } from '../domain/errors/app-error.js';
import type { ApplicationServices } from './services.js';
import { registerErrorHandler } from './middlewares/error-handler.js';
import { registerCoreRoutes } from './routes/core-routes.js';
import { registerOrganizationRoutes } from './routes/organization-routes.js';

export async function createHttpServer(services: ApplicationServices, normalizeError: (error: unknown) => AppError | undefined) {
  const app = Fastify({ logger: true });
  await app.register(helmet);
  await app.register(cors, { origin: false });
  await app.register(swagger, { openapi: { info: { title: 'Reloj Checador API', version: '0.1.0' } } });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  registerErrorHandler(app, normalizeError);
  registerCoreRoutes(app, services);
  registerOrganizationRoutes(app, services);
  return app;
}
