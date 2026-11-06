import { describe, expect, it } from 'vitest';
import { clockTimeSnapshot, clockWallTimeMilliseconds, manualClockDifferenceSeconds, validateManualClockTime } from '../src/domain/entities/device-clock.js';
import { clockCommandPayload, decodeClockTime, encodeClockTime } from '../src/infrastructure/integrations/zkteco/clock-time-codec.js';

describe('device clock local time and wire format', () => {
  it('uses the fixed 31-day protocol calendar rather than Unix time', () => {
    expect(encodeClockTime('2000-01-01 00:00:00').toString('hex')).toBe('00000000');
    expect(encodeClockTime('2000-01-02 00:00:00').readUInt32LE()).toBe(86400);
    expect(encodeClockTime('2000-03-01 00:00:00').readUInt32LE()).toBe(62 * 86400);
    expect(encodeClockTime('2001-01-01 00:00:00').readUInt32LE()).toBe(372 * 86400);
    for (const local of ['2000-02-29 23:59:59', '2026-10-28 00:00:00', '2099-12-31 23:59:59']) expect(decodeClockTime(encodeClockTime(local))).toBe(local);
  });

  it('compares wall clocks using the branch zone, independently of the host or browser zone', () => {
    const reading = { localTime: '2026-10-28 10:35:05', measuredAt: '2026-10-28T16:30:00.000Z' };
    expect(clockTimeSnapshot(reading, 'America/Mexico_City')).toMatchObject({ referenceLocalTime: '2026-10-28 10:30:00', driftSeconds: 305 });
    expect(clockTimeSnapshot(reading, 'America/Cancun')).toMatchObject({ referenceLocalTime: '2026-10-28 11:30:00', driftSeconds: -3295 });
    expect(clockTimeSnapshot({ ...reading, localTime: '2026-10-29 00:01:00', measuredAt: '2026-10-29T05:59:00Z' }, 'America/Mexico_City').driftSeconds).toBe(120);
  });

  it('rejects invalid calendar values, out-of-range years and malformed responses', () => {
    for (const value of ['2026-02-29 10:00:00', '2026-04-31 10:00:00', '2026-10-28 24:00:00', 'bad time']) expect(() => clockWallTimeMilliseconds(value)).toThrow();
    expect(() => encodeClockTime('1999-12-31 23:59:59')).toThrow();
    expect(() => encodeClockTime('2100-01-01 00:00:00')).toThrow();
    expect(() => decodeClockTime(Buffer.alloc(3))).toThrow();
    expect(() => clockCommandPayload(null)).toThrow();
    expect(() => clockCommandPayload(Buffer.alloc(8))).toThrow('rechazó');
    expect(() => clockTimeSnapshot({ localTime: '2026-10-28 10:30:00', measuredAt: 'bad' }, 'America/Mexico_City')).toThrow();
  });

  it('validates a manual local time without accepting offsets, UTC suffixes or nonexistent dates', () => {
    for (const value of ['2000-02-29 00:00:00', '2099-12-31 23:59:59']) expect(() => validateManualClockTime(value)).not.toThrow();
    for (const value of ['', '1999-12-31 23:59:59', '2100-01-01 00:00:00', '2026-02-29 10:00:00', '2026-04-31 10:00:00',
      '2026-10-28 24:00:00', '2026-10-28 10:00:00Z', '2026-10-28T10:00:00', '2026-10-28 10:00:00-06:00']) {
      expect(() => validateManualClockTime(value)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
    }
  });

  it('verifies the requested wall time plus elapsed seconds, including midnight, independently of server time', () => {
    const target = { localTime: '2025-12-31 23:59:58', sentAt: '2026-10-28T16:30:00Z' };
    expect(manualClockDifferenceSeconds(target, { localTime: '2026-01-01 00:00:01', measuredAt: '2026-10-28T16:30:03Z' })).toBe(0);
    expect(manualClockDifferenceSeconds(target, { localTime: '2025-12-31 23:59:58', measuredAt: '2026-10-28T16:30:10Z' })).toBe(-10);
    expect(() => manualClockDifferenceSeconds(target, { localTime: '2025-12-31 23:59:58', measuredAt: '2026-10-28T16:29:59Z' })).toThrow();
  });
});
