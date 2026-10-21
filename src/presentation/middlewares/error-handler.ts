import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError, type AppErrorCode } from '../../domain/errors/app-error.js';

const statusCodes: Record<AppErrorCode, number> = {
  INVALID_CONFIGURATION: 400, UNKNOWN_PHOTO_USERS: 400, CONFLICT: 409, NOT_FOUND: 404,
  EXTERNAL_SERVICE_ERROR: 502, EXTERNAL_SERVICE_UNAVAILABLE: 503, EXTERNAL_SERVICE_TIMEOUT: 504, PERSISTENCE_UNAVAILABLE: 503,
};

export function registerErrorHandler(app: FastifyInstance, normalizeError: (error: unknown) => AppError | undefined): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({
      message: error.issues.find((issue) => issue.code === 'custom')?.message ?? 'Solicitud inválida.', issues: error.issues,
    });
    const applicationError = error instanceof AppError ? error : normalizeError(error);
    if (applicationError) {
      const statusCode = statusCodes[applicationError.code];
      if (statusCode >= 500) request.log.error({ err: error }, applicationError.message);
      return reply.code(statusCode).send({ message: applicationError.message });
    }
    if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 400) {
      return reply.code(400).send({ message: 'Solicitud inválida.' });
    }
    request.log.error({ err: error }, 'Error no controlado en la solicitud.');
    return reply.code(500).send({ message: 'Error interno.' });
  });
}
