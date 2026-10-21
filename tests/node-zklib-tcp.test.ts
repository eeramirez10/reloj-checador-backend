import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
interface TcpReader {
  requestData(message: Buffer): Promise<Buffer | null>;
  readWithBuffer(request: Buffer): Promise<{ data: Buffer; mode?: number }>;
}
const TcpClient = require('node-zklib/zklibtcp') as new (ip: string, port: number, timeout: number) => TcpReader;
const { COMMANDS } = require('node-zklib/constants') as { COMMANDS: { CMD_DATA: number; CMD_PREPARE_DATA: number } };
const { createTCPHeader } = require('node-zklib/utils') as {
  createTCPHeader(command: number, session: number, reply: number, data: Buffer): Buffer;
};

describe('patched node-zklib TCP buffer reader', () => {
  it('returns the original request failure without continuing with a null buffer', async () => {
    const client = new TcpClient('127.0.0.1', 4370, 1_000);
    const failure = new Error('TIMEOUT_ON_RECEIVING_REQUEST_DATA');
    client.requestData = async () => { throw failure; };
    await expect(client.readWithBuffer(Buffer.alloc(0))).rejects.toBe(failure);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it.each([null, Buffer.alloc(0), Buffer.alloc(8)])('rejects an absent or truncated TCP header (%s)', async (response) => {
    const client = new TcpClient('127.0.0.1', 4370, 1_000);
    client.requestData = async () => response;
    await expect(client.readWithBuffer(Buffer.alloc(0))).rejects.toThrow('INVALID_TCP_BUFFER_RESPONSE');
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('rejects a missing prepared-data size without an unhandled RangeError', async () => {
    const client = new TcpClient('127.0.0.1', 4370, 1_000);
    client.requestData = async () => createTCPHeader(COMMANDS.CMD_PREPARE_DATA, 0, 0, Buffer.alloc(0));
    await expect(client.readWithBuffer(Buffer.alloc(0))).rejects.toThrow('INVALID_TCP_BUFFER_SIZE');
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it('preserves a valid data packet byte for byte', async () => {
    const client = new TcpClient('127.0.0.1', 4370, 1_000);
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    client.requestData = async () => createTCPHeader(COMMANDS.CMD_DATA, 0, 0, payload);
    await expect(client.readWithBuffer(Buffer.alloc(0))).resolves.toEqual({ data: payload, mode: 8 });
  });
});
