import { afterEach, describe, expect, it, vi } from 'vitest';
import ZKLib from 'node-zklib';
import type { Device } from '../src/domain/entities/device.js';
import { createRequire } from 'node:module';
import { DirectNodeZkLibClient as NodeZkLibClient } from '../src/infrastructure/integrations/zkteco/direct-node-zklib-client.js';

const require = createRequire(import.meta.url);
const { decodeRecordData40 } = require('node-zklib/utils.js') as {
  decodeRecordData40: (data: Buffer) => Record<string, unknown>;
};

describe('NodeZkLibClient', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('normalizes SDK errors that do not extend Error and closes failed connections', async () => {
    vi.spyOn(ZKLib.prototype, 'createSocket').mockRejectedValue({ err: { code: 'ECONNREFUSED', message: 'Connection refused' }, command: 'CONNECT' });
    const disconnect = vi.spyOn(ZKLib.prototype, 'disconnect').mockResolvedValue();
    const client = new NodeZkLibClient(1_000, 5_200);
    await expect(client.testConnection({ name: 'Reloj', ipAddress: '127.0.0.1', tcpPort: 4370 } as Device))
      .rejects.toMatchObject({ code: 'EXTERNAL_SERVICE_ERROR', message: expect.stringContaining('Connection refused') });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('times out a stuck SDK operation and still disconnects', async () => {
    vi.useFakeTimers();
    vi.spyOn(ZKLib.prototype, 'createSocket').mockResolvedValue();
    vi.spyOn(ZKLib.prototype, 'getInfo').mockImplementation(() => new Promise(() => {}));
    const disconnect = vi.spyOn(ZKLib.prototype, 'disconnect').mockResolvedValue();
    const result = new NodeZkLibClient(1_000, 5_200).testConnection({ name: 'Reloj', ipAddress: '127.0.0.1', tcpPort: 4370 } as Device);
    const failure = expect(result).rejects.toMatchObject({ code: 'EXTERNAL_SERVICE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(1_000);
    await failure;
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('bounds a stalled connection separately from a longer operation and never runs commands after a late connect', async () => {
    vi.useFakeTimers();
    let connected!: () => void;
    vi.spyOn(ZKLib.prototype, 'createSocket').mockImplementation(() => new Promise<void>((resolve) => { connected = resolve; }));
    const info = vi.spyOn(ZKLib.prototype, 'getInfo');
    const disconnect = vi.spyOn(ZKLib.prototype, 'disconnect').mockResolvedValue();
    const result = new NodeZkLibClient(1_000,5_200,10_000).testConnection({ name: 'Veracruz',ipAddress: '192.168.2.201',tcpPort: 4370 } as Device);
    const failure = expect(result).rejects.toMatchObject({ code: 'EXTERNAL_SERVICE_TIMEOUT',message: expect.stringContaining('Veracruz (192.168.2.201:4370)') });
    await vi.advanceTimersByTimeAsync(1_000); await failure;
    connected(); await vi.advanceTimersByTimeAsync(0);
    expect(info).not.toHaveBeenCalled(); expect(disconnect).toHaveBeenCalledOnce();
  });
  it('decodes verification and attendance state from TCP records', () => {
    const packet = Buffer.alloc(40);
    packet.writeUInt16LE(15_645, 0);
    packet.write('1514', 2, 'ascii');
    packet.writeUInt8(2, 26);
    packet.writeUInt32LE(0, 27);
    packet.writeUInt8(1, 31);

    expect(decodeRecordData40(packet)).toMatchObject({
      userSn: 15_645,
      verificationType: 2,
      punchState: 1
    });
  });

  it('normalizes the deviceUserId and recordTime fields used by TCP attendance packets', async () => {
    const client = new NodeZkLibClient(1_000, 5_200) as any;
    client.withClient = async (_device: unknown, callback: (socket: unknown) => Promise<unknown>) => callback({
      getAttendances: async () => ({ data: [{ deviceUserId: '15', recordTime: new Date('2026-07-31T08:00:00Z') }] })
    });
    const records = await client.getAttendance({ ipAddress: '192.168.1.201', tcpPort: 4370 } as any);
    expect(records).toEqual([expect.objectContaining({ userId: '15', occurredAt: new Date('2026-07-31T08:00:00Z') })]);
  });

  it('uses the stable record serial as the event ID and preserves its state', async () => {
    const client = new NodeZkLibClient(1_000, 5_200) as any;
    client.withClient = async (_device: unknown, callback: (socket: unknown) => Promise<unknown>) => callback({
      getAttendances: async () => ({ data: [{ userSn: 15_645, deviceUserId: '1514', recordTime: new Date('2026-07-31T08:00:00Z'), verificationType: 1, punchState: 0 }] })
    });

    const [event] = await client.getAttendance({ ipAddress: '192.168.1.199', tcpPort: 4370 } as any);

    expect(event).toMatchObject({ deviceLogId: '15645', userId: '1514', verificationType: 1, punchState: 0 });
  });

  it('downloads user names without retaining passwords', async () => {
    const client = new NodeZkLibClient(1_000, 5_200) as any;
    client.withClient = async (_device: unknown, callback: (socket: unknown) => Promise<unknown>) => callback({
      getUsers: async () => ({ data: [{ userId: '1517', uid: 11934, name: 'Ana Perez', role: 0, cardno: 1234, password: 'never-store-this' }] })
    });
    const users = await client.getUsers({ ipAddress: '192.168.1.201', tcpPort: 4370 } as any);
    expect(users).toEqual([expect.objectContaining({ userId: '1517', name: 'Ana Perez', cardNumber: '1234' })]);
    expect(users[0].raw).not.toHaveProperty('password');
  });

  it('interprets clock-local records using Cancun time rather than the server time zone', async () => {
    const client = new NodeZkLibClient(1_000, 5_200) as any;
    client.withClient = async (_device: unknown, callback: (socket: unknown) => Promise<unknown>) => callback({
      getAttendances: async () => ({ data: [{ userSn: 10, deviceUserId: '601', recordTime: new Date(2026, 9, 20, 8, 30, 12) }] })
    });
    const [cancun] = await client.getAttendance({ timeZone: 'America/Cancun' } as any);
    const [mexico] = await client.getAttendance({ timeZone: 'America/Mexico_City' } as any);
    expect(cancun.occurredAt.toISOString()).toBe('2026-10-20T13:30:12.000Z');
    expect(mexico.occurredAt.toISOString()).toBe('2026-10-20T14:30:12.000Z');
    expect(cancun.raw).toMatchObject({ deviceLocalTime: '2026-10-20 08:30:12', deviceTimeZone: 'America/Cancun' });
  });

  it('preserves timestamps that already include an absolute time zone', async () => {
    const client = new NodeZkLibClient(1_000, 5_200) as any;
    client.withClient = async (_device: unknown, callback: (socket: unknown) => Promise<unknown>) => callback({
      getAttendances: async () => ({ data: [{ deviceUserId: '601', timestamp: '2026-10-20T13:30:12Z' }] })
    });
    const [event] = await client.getAttendance({ timeZone: 'America/Cancun' } as any);
    expect(event.occurredAt.toISOString()).toBe('2026-10-20T13:30:12.000Z');
  });
});
