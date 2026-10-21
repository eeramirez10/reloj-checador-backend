import { describe, expect, it } from 'vitest';
import { formatDateTimeInTimeZone, summarizeAttendance } from '../src/attendance/attendance-summary.js';

describe('summarizeAttendance', () => {
  it('pairs punches chronologically and leaves an unmatched entry open', () => {
    const logs = [
      { occurredAt: new Date('2026-07-31T14:00:00Z') },
      { occurredAt: new Date('2026-07-31T18:00:00Z') },
      { occurredAt: new Date('2026-07-31T19:00:00Z') }
    ] as any;
    const [summary] = summarizeAttendance(logs, 'America/Mexico_City');
    expect(summary.date).toBe('2026-07-31');
    expect(summary.firstEntry).toEqual(new Date('2026-07-31T14:00:00Z'));
    expect(summary.lastExit).toEqual(new Date('2026-07-31T18:00:00Z'));
    expect(summary.openEntry).toEqual(new Date('2026-07-31T19:00:00Z'));
    expect(summary.workedMinutes).toBe(240);
  });

  it('uses recorded punch states instead of alternating inferred states', () => {
    const logs = [
      { occurredAt: new Date('2026-07-31T14:00:00Z'), punchState: 0 },
      { occurredAt: new Date('2026-07-31T18:00:00Z'), punchState: 2 },
      { occurredAt: new Date('2026-07-31T18:30:00Z'), punchState: 3 },
      { occurredAt: new Date('2026-07-31T23:00:00Z'), punchState: 1 }
    ] as any;
    const [summary] = summarizeAttendance(logs, 'America/Mexico_City');

    expect(summary.punches.map((punch) => punch.type)).toEqual(['entry', 'exit', 'entry', 'exit']);
    expect(summary.workedMinutes).toBe(510);
    expect(summary.inferred).toBe(false);
  });

  it('formats timestamps in Mexico City time', () => {
    expect(formatDateTimeInTimeZone(new Date('2026-07-31T19:45:02Z'), 'America/Mexico_City')).toBe('2026-07-31 13:45:02');
  });
});
