import { describe, expect, it } from 'vitest';
import { NodeZkLibClient } from '../src/infrastructure/integrations/zkteco/node-zklib-client.js';
import type { Device } from '../src/domain/entities/device.js';
import { createServer, type Socket } from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { COMMANDS } = require('node-zklib/constants') as {
  COMMANDS: { CMD_ACK_OK: number; CMD_GET_FREE_SIZES: number; CMD_DATA_WRRQ: number; CMD_DATA: number };
};
const { createTCPHeader } = require('node-zklib/utils') as {
  createTCPHeader(command: number, session: number, reply: number, data: Buffer): Buffer;
};

const workerPath = new URL('./fixtures/zkteco-worker.cjs', import.meta.url);
function device(name: string): Device {
  return { id: 'clock', name, ipAddress: '127.0.0.1', tcpPort: 4370, driver: 'node', enabled: true,
    syncIntervalSeconds: 60, createdAt: new Date(), updatedAt: new Date() };
}

describe('isolated ZKTeco operations', () => {
  it('loads the production TypeScript worker and reads real TCP protocol responses', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      let pending = Buffer.alloc(0);
      socket.on('data', (data) => {
        pending = Buffer.concat([pending, data]);
        while (pending.length >= 16) {
          const length = 8 + pending.readUInt16LE(4);
          if (pending.length < length) return;
          const command = pending.readUInt16LE(8);
          pending = pending.subarray(length);
          if (command === COMMANDS.CMD_GET_FREE_SIZES) {
            const payload = Buffer.alloc(72);
            payload.writeUInt32LE(12, 16);
            payload.writeUInt32LE(24, 32);
            payload.writeUInt32LE(50_000, 64);
            socket.write(createTCPHeader(COMMANDS.CMD_ACK_OK, 1, 0, payload));
          } else if (command === COMMANDS.CMD_DATA_WRRQ) {
            const record = Buffer.alloc(40);
            record.writeUInt16LE(42, 0);
            record.write('0015', 2, 'ascii');
            record.writeUInt8(2, 26);
            record.writeUInt8(1, 31);
            socket.write(createTCPHeader(COMMANDS.CMD_DATA, 1, 0, Buffer.concat([Buffer.alloc(4), record])));
          } else socket.write(createTCPHeader(COMMANDS.CMD_ACK_OK, 1, 0, Buffer.alloc(0)));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No se pudo iniciar el reloj de prueba.');
      const clock = { ...device('healthy'), tcpPort: address.port };
      const client = new NodeZkLibClient(2_000, 5_200, { operationTimeoutMs: 10_000 });
      await expect(client.testConnection(clock)).resolves.toEqual({ raw: { userCounts: 12, logCounts: 24, logCapacity: 50_000 } });
      const [event] = await client.getAttendance(clock);
      expect(event).toMatchObject({ deviceLogId: '42', userId: '0015', verificationType: 2, punchState: 1 });
      expect(event.occurredAt).toBeInstanceOf(Date);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it('contains an uncaught null-buffer callback and accepts the next operation', async () => {
    const client = new NodeZkLibClient(1_000, 5_200, { workerPath, operationTimeoutMs: 1_000 });
    const failure = await client.testConnection(device('crash')).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'EXTERNAL_SERVICE_ERROR' });
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(String((failure as Error).cause)).toContain("Cannot read properties of null (reading 'subarray')");
    await expect(client.testConnection(device('healthy'))).resolves.toEqual({ raw: { connected: true } });
  });

  it('terminates a stuck worker at the configured deadline', async () => {
    const client = new NodeZkLibClient(100, 5_200, { workerPath, operationTimeoutMs: 100, startupTimeoutMs: 500 });
    await expect(client.testConnection(device('hang'))).rejects.toMatchObject({ code: 'EXTERNAL_SERVICE_TIMEOUT' });
  });

  it('rejects an invalid IPC response and cleans up its worker', async () => {
    const client = new NodeZkLibClient(1_000, 5_200, { workerPath, operationTimeoutMs: 1_000 });
    await expect(client.testConnection(device('invalid'))).rejects.toThrow('respuesta inválida');
  });

  it('preserves Date values and external user identifiers across process boundaries', async () => {
    const client = new NodeZkLibClient(1_000, 5_200, { workerPath, operationTimeoutMs: 1_000 });
    const [event] = await client.getAttendance(device('healthy'));
    expect(event.occurredAt).toBeInstanceOf(Date);
    expect(event.occurredAt.toISOString()).toBe('2025-10-22T14:30:00.000Z');
    expect(event.raw).toEqual({ recordTime: event.occurredAt });
    expect((await client.getUsers(device('healthy')))[0].userId).toBe('0015');
  });
});
