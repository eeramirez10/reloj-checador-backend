import { describe, expect, it } from 'vitest';
import { formatDateTimeInTimeZone, summarizeAttendance } from '../src/domain/entities/attendance-summary.js';
import { dateAtLocalTime, evaluateDay } from '../src/domain/entities/schedule-evaluator.js';
import type { ScheduleSettings } from '../src/domain/entities/organization.js';

const date = '2026-10-20';
const zone = 'America/Mexico_City';
const schedule: ScheduleSettings = { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30',
  mealEnabled: true, mealStart: '15:00', mealEnd: '15:00', mealDurationMinutes: 60 };
function day(times: string[]) {
  return evaluateDay(date, times.map((time, index) => ({ id: String(index), occurredAt: dateAtLocalTime(date, time, zone), punchState: 0 })),
    schedule, undefined, zone, new Date('2026-10-21T12:00:00Z'));
}

describe('canonical attendance summaries', () => {
  it('builds work sessions from the classified day regardless of the selected clock mode', () => {
    const [summary] = summarizeAttendance([day(['08:30','15:00','16:00','17:30'])]);
    expect(summary.punches.map((punch) => punch.type)).toEqual(['entry','exit','entry','exit']);
    expect(summary.workedMinutes).toBe(480);
    expect(summary.inferred).toBe(true);
    expect(summary.sessions).toHaveLength(2);
  });
  it('keeps unknown worked time and the missing return explicit when the last punch is a work exit', () => {
    const [summary] = summarizeAttendance([day(['08:30','15:00','17:30'])]);
    expect(summary.lastExit).toEqual(dateAtLocalTime(date, '17:30', zone));
    expect(summary.workedMinutes).toBeNull();
    expect(summary.missingMovements).toContain('meal_return');
    expect(summary.sessions).toHaveLength(1);
  });
  it('formats timestamps in Mexico City time', () => {
    expect(formatDateTimeInTimeZone(new Date('2026-07-31T19:45:02Z'), zone)).toBe('2026-07-31 13:45:02');
  });
});
