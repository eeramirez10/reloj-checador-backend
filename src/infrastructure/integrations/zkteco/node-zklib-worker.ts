import { errorMessage, ExternalServiceError } from '../../../domain/errors/app-error.js';
import { DirectNodeZkLibClient } from './direct-node-zklib-client.js';
import { isWorkerErrorCode, isWorkerRequest, type ZktecoWorkerResponse } from './worker-protocol.js';

function respond(response: ZktecoWorkerResponse): void {
  if (!process.send) process.exit(1);
  process.send(response, (error) => { process.exit(error ? 1 : 0); });
}

function reportFailure(error: unknown): void {
  const code = error instanceof ExternalServiceError && isWorkerErrorCode(error.code) ? error.code : 'EXTERNAL_SERVICE_ERROR';
  respond({ type: 'failure', error: { message: errorMessage(error), code, stack: error instanceof Error ? error.stack : undefined } });
}

async function execute(request: unknown): Promise<void> {
  if (!isWorkerRequest(request)) throw new ExternalServiceError('Solicitud inválida para el controlador del reloj.');
  const client = new DirectNodeZkLibClient(request.timeoutMs, request.inPort, request.operationTimeoutMs);
  const value = await client[request.operation](request.device);
  respond({ type: 'success', value });
}

process.once('disconnect', () => { process.exit(0); });
process.once('message', (request: unknown) => { void execute(request).catch(reportFailure); });
