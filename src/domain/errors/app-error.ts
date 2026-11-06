export type AppErrorCode = 'INVALID_CONFIGURATION' | 'CONFLICT' | 'NOT_FOUND' | 'UNKNOWN_PHOTO_USERS'
  | 'EXTERNAL_SERVICE_ERROR' | 'EXTERNAL_SERVICE_UNAVAILABLE' | 'EXTERNAL_SERVICE_TIMEOUT' | 'PERSISTENCE_UNAVAILABLE'
  | 'UNAUTHORIZED' | 'FORBIDDEN' | 'TOO_MANY_REQUESTS';

export class AppError extends Error {
  constructor(message: string, readonly code: AppErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string) { super(message, 'INVALID_CONFIGURATION'); }
}

export class ConflictError extends AppError {
  constructor(message: string, options?: ErrorOptions) { super(message, 'CONFLICT', options); }
}

export class ExternalServiceError extends AppError {
  constructor(message: string,
    code: 'EXTERNAL_SERVICE_ERROR' | 'EXTERNAL_SERVICE_UNAVAILABLE' | 'EXTERNAL_SERVICE_TIMEOUT' = 'EXTERNAL_SERVICE_ERROR', options?: ErrorOptions) {
    super(message, code, options);
  }
}

export class PhotoBridgeError extends ExternalServiceError {}
export class SyncAlreadyRunningError extends ConflictError {}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    if ('message' in error && typeof error.message === 'string') return error.message;
    if ('err' in error) return errorMessage(error.err);
    if ('code' in error && typeof error.code === 'string') return error.code;
  }
  return 'Error desconocido.';
}
