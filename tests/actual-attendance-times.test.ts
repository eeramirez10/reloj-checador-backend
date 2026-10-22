import { describe, expect, it } from 'vitest';
import { dateAtLocalTime, evaluateDay } from '../src/domain/entities/schedule-evaluator.js';
import type { ScheduleSettings } from '../src/domain/entities/organization.js';

const date = '2026-10-20';
const zone = 'America/Mexico_City';
const now = new Date('2026-10-21T12:00:00Z');
const schedule: ScheduleSettings = { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30',
  mealEnabled: true, mealStart: '15:00', mealEnd: '15:00', mealDurationMinutes: 60, recognitionMarginMinutes: 30 };
const policy = { entryToleranceMinutes: 15, mealToleranceMinutes: 15, entryAllowedTardies: 3,
  mealAllowedTardies: 3, accumulationMode: 'first_lateness' as const, accumulationDays: 30 };

function evaluate(times: string[], settings = schedule, at = now) {
  return evaluateDay(date, times.map((time,index) => ({ id: `log-${index}`, occurredAt: dateAtLocalTime(date,time,zone), punchState: 0 })),
    settings, policy, zone, at);
}

describe('actual workday entry and exit times', () => {
  it.each([
    ['06:46','15:00','16:00','17:36'],
    ['06:58','15:00','16:00','18:27'],
    ['07:29','15:00','16:00','20:30'],
    ['06:00','15:00','16:00','16:20'],
  ])('preserves actual early entry and early or late exit (%s, %s, %s, %s)', (...times) => {
    const result = evaluate(times);
    expect(result.entry).toBe(dateAtLocalTime(date,times[0],zone).toISOString());
    expect(result.exit).toBe(dateAtLocalTime(date,times[3],zone).toISOString());
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry','meal_departure','meal_return','exit']);
    expect(result.incidents.filter((incident) => incident.kind === 'arrival')).toEqual([]);
    expect(result.status).toBe('complete');
  });

  it('keeps actual endpoints visible while meal settings remain pending', () => {
    const result = evaluate(['06:58','12:00','18:27'], { ...schedule, mealEnabled: false, mealPending: true });
    expect(result.entry).toBe(dateAtLocalTime(date,'06:58',zone).toISOString());
    expect(result.exit).toBe(dateAtLocalTime(date,'18:27',zone).toISOString());
    expect(result.status).toBe('unconfigured');
    expect(result.workedMinutes).toBeUndefined();
  });

  it('shows an actual late arrival beyond the recognition margin and evaluates its tardiness', () => {
    const result = evaluate(['09:45','15:00','16:00','19:00']);
    expect(result.entry).toBe(dateAtLocalTime(date,'09:45',zone).toISOString());
    expect(result.incidents).toContainEqual(expect.objectContaining({ kind: 'arrival', minutes: 75 }));
  });

  it('does not use a single early punch as both entry and exit', () => {
    const result = evaluate(['06:46']);
    expect(result.entry).toBe(dateAtLocalTime(date,'06:46',zone).toISOString());
    expect(result.exit).toBeUndefined();
    expect(result.missingMovements).toContain('exit');
  });

  it('uses the last effective punch as work exit on a closed day, even within a meal window', () => {
    const departed = evaluate(['06:46','15:00']);
    expect(departed.mealDeparture).toBeUndefined();
    expect(departed.exit).toBe(dateAtLocalTime(date,'15:00',zone).toISOString());
    expect(departed.missingMovements).toEqual(['meal_departure','meal_return']);
    const returned = evaluate(['06:46','15:00','16:00']);
    expect(returned.mealDeparture).toBeDefined();
    expect(returned.mealReturn).toBeUndefined();
    expect(returned.exit).toBe(dateAtLocalTime(date,'16:00',zone).toISOString());
    expect(returned.missingMovements).toEqual(['meal_return']);
    expect(returned.workedMinutes).toBeUndefined();
  });

  it('keeps meal movements provisional while a partial workday is still open', () => {
    const departed = evaluate(['06:46','15:00'], schedule, dateAtLocalTime(date,'15:05',zone));
    expect(departed.mealDeparture).toBeDefined();
    expect(departed.exit).toBeUndefined();
    const returned = evaluate(['06:46','15:00','16:00'], schedule, dateAtLocalTime(date,'16:05',zone));
    expect(returned.mealReturn).toBeDefined();
    expect(returned.exit).toBeUndefined();
    expect(returned.status).toBe('in_progress');
  });

  it('does not turn an unexpected intermediate punch into an exit during an unfinished workday', () => {
    const result = evaluate(['06:46','11:30'], schedule, dateAtLocalTime(date,'11:35',zone));
    expect(result.entry).toBeDefined();
    expect(result.punches[1].movement).toBe('outside_schedule');
    expect(result.exit).toBeUndefined();
  });

  it('keeps an unconfigured midday meal mark pending while the workday is still open', () => {
    const result = evaluate(['06:46','15:00'], { ...schedule, mealEnabled: false, mealPending: true }, dateAtLocalTime(date,'15:05',zone));
    expect(result.entry).toBeDefined();
    expect(result.exit).toBeUndefined();
    expect(result.status).toBe('unconfigured');
  });

  it('recognizes an early final exit before lunch on an already closed day', () => {
    const result = evaluate(['06:46','12:00']);
    expect(result.exit).toBe(dateAtLocalTime(date,'12:00',zone).toISOString());
    expect(result.missingMovements).toEqual(['meal_departure','meal_return']);
    expect(result.workedMinutes).toBeUndefined();
  });

  it('can distinguish a meal return near scheduled exit when a later actual exit exists', () => {
    const result = evaluate(['06:46','16:00','17:15','20:30'], { ...schedule, mealStart: '16:00', mealEnd: '16:00' });
    expect(result.mealReturn).toBe(dateAtLocalTime(date,'17:15',zone).toISOString());
    expect(result.exit).toBe(dateAtLocalTime(date,'20:30',zone).toISOString());
    expect(result.status).toBe('complete');
  });

  it('keeps actual times on a day off without creating tardiness penalties', () => {
    const result = evaluate(['06:46','15:00','16:00','20:30'], { ...schedule, workDays: [6] });
    expect(result.entry).toBeDefined();
    expect(result.exit).toBeDefined();
    expect(result.status).toBe('day_off');
    expect(result.incidents).toEqual([]);
  });
});
