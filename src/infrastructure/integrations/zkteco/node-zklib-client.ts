import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Device } from '../../../domain/entities/device.js';
import type { DeviceInfo, ZktecoAttendanceEvent, ZktecoDeviceClient, ZktecoUser } from '../../../domain/datasources/device-client.js';
import { ExternalServiceError } from '../../../domain/errors/app-error.js';
import { isWorkerResponse, type DeviceOperation, type ZktecoWorkerRequest, type ZktecoWorkerResponse } from './worker-protocol.js';

interface WorkerOptions { workerPath?: URL; operationTimeoutMs?: number; startupTimeoutMs?: number }

const maximumDiagnosticLength = 8_192;
const workerFile = import.meta.url.endsWith('.ts') ? './node-zklib-worker.ts' : './node-zklib-worker.js';
const typescriptLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

export class NodeZkLibClient implements ZktecoDeviceClient {
  private readonly workerPath: URL;
  private readonly operationTimeoutMs: number;
  private readonly startupTimeoutMs: number;

  constructor(private readonly timeoutMs: number, private readonly inPort: number, options: WorkerOptions = {}) {
    this.workerPath = options.workerPath ?? new URL(workerFile, import.meta.url);
    this.operationTimeoutMs = options.operationTimeoutMs ?? 120_000;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 5_000;
  }

  testConnection(device: Device): Promise<DeviceInfo> { return this.execute('testConnection', device); }
  getAttendance(device: Device): Promise<ZktecoAttendanceEvent[]> { return this.execute('getAttendance', device); }
  getUsers(device: Device): Promise<ZktecoUser[]> { return this.execute('getUsers', device); }

  private async execute<T>(operation: DeviceOperation, device: Device): Promise<T> {
    try {
      return await this.runWorker<T>({ operation, device, timeoutMs: this.timeoutMs, operationTimeoutMs: this.operationTimeoutMs, inPort: this.inPort });
    } catch (error) {
      if (error instanceof ExternalServiceError) throw error;
      throw new ExternalServiceError(`No se pudo iniciar el controlador de ${device.name}.`, 'EXTERNAL_SERVICE_ERROR', { cause: error });
    }
  }

  private runWorker<T>(request: ZktecoWorkerRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = fork(this.workerPath, [], {
        execArgv: this.workerPath.pathname.endsWith('.ts') ? ['--import', typescriptLoader] : [],
        serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let response: ZktecoWorkerResponse | undefined;
      let failure: ExternalServiceError | undefined;
      let diagnostic = '';
      const fail = (error: ExternalServiceError) => {
        failure ??= error;
        worker.kill('SIGKILL');
      };
      const deadline = this.startupTimeoutMs + this.operationTimeoutMs + this.timeoutMs;
      const timer = setTimeout(() => fail(new ExternalServiceError(
        `Se agotó el tiempo del controlador de ${request.device.name}.`, 'EXTERNAL_SERVICE_TIMEOUT')), deadline);

      worker.stderr?.on('data', (data: Buffer) => {
        diagnostic = (diagnostic + data.toString('utf8')).slice(-maximumDiagnosticLength);
      });
      worker.on('error', (error) => fail(new ExternalServiceError(
        `Falló el proceso del reloj ${request.device.name}.`, 'EXTERNAL_SERVICE_ERROR', { cause: error })));
      worker.on('message', (message: unknown) => {
        if (!isWorkerResponse(message) || response) {
          fail(new ExternalServiceError(`El controlador de ${request.device.name} devolvió una respuesta inválida.`));
          return;
        }
        response = message;
      });
      worker.once('disconnect', () => {
        if (!response) fail(new ExternalServiceError(`El controlador de ${request.device.name} perdió la comunicación.`));
      });
      worker.once('close', (code, signal) => {
        clearTimeout(timer);
        if (failure) {
          if (diagnostic && !failure.cause) failure.cause = new Error(diagnostic.trim());
          return reject(failure);
        }
        if (response?.type === 'failure') {
          const cause = new Error(response.error.message);
          if (response.error.stack) cause.stack = response.error.stack;
          return reject(new ExternalServiceError(response.error.message, response.error.code, { cause }));
        }
        if (code !== 0 || signal || !response) {
          return reject(new ExternalServiceError(`El controlador de ${request.device.name} terminó inesperadamente.`,
            'EXTERNAL_SERVICE_ERROR', { cause: new Error(diagnostic.trim() || `Exit: ${code}; signal: ${signal}`) }));
        }
        resolve(response.value as T);
      });
      worker.send(request, (error) => {
        if (error) fail(new ExternalServiceError(`No se pudo enviar la solicitud al controlador de ${request.device.name}.`,
          'EXTERNAL_SERVICE_ERROR', { cause: error }));
      });
    });
  }
}
