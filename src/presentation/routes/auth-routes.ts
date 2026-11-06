import type { FastifyInstance } from 'fastify';
import { serialize } from 'cookie';
import { z } from 'zod';
import type { ApplicationServices } from '../services.js';
import { accountSchema, loginSchema, passwordSchema } from '../validators/auth.js';
import { idParams } from '../validators/common.js';

export function registerAuthRoutes(app: FastifyInstance, services: ApplicationServices) {
  const { auth, access, authentication } = services;
  const cookieName = authentication.secureCookie ? '__Host-reloj_session' : 'reloj_session';
  const cookie = (value: string, maxAge: number) => serialize(cookieName, value, { path: '/', httpOnly: true, sameSite: 'strict', secure: authentication.secureCookie, maxAge });
  app.post('/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const token = await auth.login(input.username, input.password);
    return reply.header('set-cookie', cookie(token, authentication.sessionHours * 3600)).code(204).send();
  });
  app.get('/auth/me', async () => {
    const { sessionHash: _hash, ...account } = access.current()!;
    return account;
  });
  app.post('/auth/logout', async (_request, reply) => {
    const principal = access.current()!;
    await auth.repository.revoke(principal.sessionHash);
    await auth.repository.audit(principal.id, 'logout');
    return reply.header('set-cookie', cookie('', 0)).code(204).send();
  });
  app.post('/auth/change-password', async (request, reply) => {
    const input = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict().parse(request.body);
    await auth.changePassword(access.current()!.id, input.currentPassword, input.newPassword);
    return reply.header('set-cookie', cookie('', 0)).code(204).send();
  });
  app.get('/auth/accounts', () => auth.repository.list());
  app.post('/auth/accounts', async (request, reply) => {
    const { password, ...input } = accountSchema.strict().parse(request.body);
    return reply.code(201).send(await auth.save(access.current()!.id, input, password));
  });
  app.patch('/auth/accounts/:id', async request => {
    const { password, expectedVersion, ...input } = accountSchema.extend({ expectedVersion: z.number().int().min(1) }).strict().parse(request.body);
    return auth.save(access.current()!.id, input, password, idParams.parse(request.params).id, expectedVersion);
  });
  app.get('/auth/audit', () => auth.repository.auditHistory());
}
