import { createServer, type Socket } from 'node:net';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { NodeZkLibClient } from '../src/infrastructure/integrations/zkteco/node-zklib-client.js';
import { encodeClockTime, decodeClockTime } from '../src/infrastructure/integrations/zkteco/clock-time-codec.js';
import { formatDateTimeInTimeZone } from '../src/domain/entities/attendance-summary.js';
import type { Device } from '../src/domain/entities/device.js';

const require = createRequire(import.meta.url);
const { createTCPHeader } = require('node-zklib/utils') as { createTCPHeader(command: number, session: number, reply: number, data: Buffer): Buffer };

describe('clock commands through the isolated native TCP worker', () => {
  it('reads, writes the branch-local time at send time, handles rejection and truncated replies and never clears the device', async () => {
    const sockets = new Set<Socket>(); const commands: number[] = [];
    let clockTime = encodeClockTime('2026-01-01 00:00:00'); let rejectWrite = false; let truncateRead = false;
    const server = createServer((socket) => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      let pending = Buffer.alloc(0);
      socket.on('data', (data) => {
        pending = Buffer.concat([pending, data]);
        while (pending.length >= 16) {
          const length = 8 + pending.readUInt16LE(4); if (pending.length < length) return;
          const packet = pending.subarray(0, length); pending = pending.subarray(length);
          const command = packet.readUInt16LE(8); commands.push(command);
          let code = 2000; let payload: Buffer = Buffer.alloc(0);
          if (command === 201) payload = truncateRead ? Buffer.alloc(2) : clockTime;
          if (command === 202) { if (rejectWrite) code = 2001; else clockTime = Buffer.from(packet.subarray(16)); }
          socket.write(createTCPHeader(code, 1, 0, payload));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No se pudo iniciar el reloj de prueba.');
      const clock: Device = { id: 'clock', name: 'Reloj de prueba', ipAddress: '127.0.0.1', tcpPort: address.port, driver: 'node', enabled: true,
        syncIntervalSeconds: 60, branchId: 'branch', timeZone: 'America/Cancun', createdAt: new Date(), updatedAt: new Date() };
      const client = new NodeZkLibClient(2000, 5200, { operationTimeoutMs: 10000 });
      expect((await client.getClockTime(clock)).localTime).toBe('2026-01-01 00:00:00');
      for (const zone of ['America/Mexico_City', 'America/Cancun']) {
        const target = await client.setClockTime({ ...clock, timeZone: zone });
        expect(target.localTime).toBe(formatDateTimeInTimeZone(new Date(target.sentAt), zone));
        expect(decodeClockTime(clockTime)).toBe(target.localTime);
        expect((await client.getClockTime(clock)).localTime).toBe(target.localTime);
      }
      const manualTime = '2025-12-31 23:59:58';
      const target = await client.setClockTime(clock, manualTime);
      expect(target.localTime).toBe(manualTime);
      expect(decodeClockTime(clockTime)).toBe(manualTime);
      expect((await client.getClockTime(clock)).localTime).toBe(manualTime);
      rejectWrite = true; await expect(client.setClockTime(clock)).rejects.toThrow('rechazó');
      truncateRead = true; await expect(client.getClockTime(clock)).rejects.toThrow('incompleta');
      truncateRead = false; expect((await client.getClockTime(clock)).localTime).toBe(decodeClockTime(clockTime));
      expect(commands.every((command) => [1000, 1001, 201, 202].includes(command))).toBe(true);
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }, 20000);
});
