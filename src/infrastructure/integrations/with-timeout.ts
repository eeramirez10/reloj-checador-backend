import { ExternalServiceError } from '../../domain/errors/app-error.js';

export async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ExternalServiceError(message, 'EXTERNAL_SERVICE_TIMEOUT')), timeoutMs);
  });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
