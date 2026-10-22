import { describe, expect, it } from 'vitest';
import { dateAtLocalTime, evaluateDay } from '../src/domain/entities/schedule-evaluator.js';
import type { PolicySettings, ScheduleSettings } from '../src/domain/entities/organization.js';
import { policySettingsSchema } from '../src/presentation/validators/organization.js';

const date = '2026-10-19';
const zone = 'America/Mexico_City';
const now = new Date('2026-10-21T12:00:00Z');
const schedule: ScheduleSettings = { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30',
  mealEnabled: false, mealStart: '00:00', mealEnd: '00:00', mealDurationMinutes: 60, mealDetection: 'automatic' };
const policy: PolicySettings = { entryToleranceMinutes: 0, mealToleranceMinutes: 0, entryAllowedTardies: 3,
  mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 };
const repeatedEntryTimes = ['07:59:53','08:06:26','15:21:22','16:30:21','18:53:27'];

function punches(times: string[]) {
  return times.map((time, index) => ({ id: `log-${index}`, punchState: index % 2,
    occurredAt: new Date(dateAtLocalTime(date, time.slice(0,5), zone).getTime() + Number(time.slice(6) || 0) * 1000) }));
}

describe('initial repeated-entry window', () => {
  it('classifies the five original scans of 3062 as four effective movements', () => {
    const logs = punches(repeatedEntryTimes);
    const original = structuredClone(logs);
    const result = evaluateDay(date, logs, schedule, policy, zone, now);
    expect(result.status).toBe('complete');
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry','duplicate','meal_departure','meal_return','exit']);
    expect(result.punches.map((punch) => punch.id)).toEqual(logs.map((log) => log.id));
    expect(result.entry).toBe(logs[0].occurredAt.toISOString());
    expect(result.exit).toBe(logs[4].occurredAt.toISOString());
    expect(result.mealMinutes).toBe(69);
    expect(result.incidents).toEqual([]);
    expect(logs).toEqual(original);
  });

  it('defaults to twenty minutes even before the first branch policy', () => {
    expect(evaluateDay(date, punches(repeatedEntryTimes), schedule, undefined, zone, now).status).toBe('complete');
  });

  it('includes the exact twenty-minute boundary without chaining from subsequent retries', () => {
    const result = evaluateDay(date, punches(['08:30','08:45','08:50','08:50:01','13:30','14:30','17:30']), schedule, policy, zone, now);
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry','duplicate','duplicate','unclassified','unclassified','unclassified','exit']);
    expect(result.status).toBe('ambiguous');
  });

  it.each([0,5])('uses a configured %i-minute window without extending it to twenty', (minutes) => {
    const result = evaluateDay(date, punches(repeatedEntryTimes), schedule, { ...policy, entryRepeatWindowMinutes: minutes }, zone, now);
    expect(result.punches[1].movement).toBe('unclassified');
    expect(result.status).toBe('ambiguous');
  });

  it('preserves a short meal instead of applying the entry window to every pair', () => {
    const result = evaluateDay(date, punches(['08:30','13:30','13:35','17:30']), schedule, policy, zone, now);
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry','meal_departure','meal_return','exit']);
    expect(result.mealMinutes).toBe(5);
  });

  it('protects an individual meal window even when it starts shortly after entry', () => {
    const individual: ScheduleSettings = { ...schedule, mealEnabled: true, mealDetection: 'configured',
      mealStart: '08:40', mealEnd: '08:40', mealDurationMinutes: 5, recognitionMarginMinutes: 0 };
    const result = evaluateDay(date, punches(['08:30','08:40','08:45','17:30']), individual, policy, zone, now);
    expect(result.status).toBe('complete');
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry','meal_departure','meal_return','exit']);
  });

  it('does not turn a repeated entry into an exit when no later effective scan exists', () => {
    const result = evaluateDay(date, punches(['08:30','08:36']), schedule, policy, zone, now);
    expect(result.entry).toBeDefined();
    expect(result.exit).toBeUndefined();
    expect(result.missingMovements).toContain('exit');
    expect(result.punches[1].movement).toBe('duplicate');
  });

  it('validates the branch setting and supplies the legacy-policy default', () => {
    expect(policySettingsSchema.parse(policy).entryRepeatWindowMinutes).toBe(20);
    for (const value of [-1,121,1.5,'20']) {
      expect(policySettingsSchema.safeParse({ ...policy, entryRepeatWindowMinutes: value }).success).toBe(false);
    }
  });
});

describe('final work exit with a missing meal return', () => {
  it('preserves the confirmed meal departure and early final work exit of 3069', () => {
    const logs = punches(['08:24:06','14:31:42','15:35:11']);
    const result = evaluateDay(date, logs, schedule, policy, zone, now);
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry','meal_departure','exit']);
    expect(result.mealDeparture).toBe(logs[1].occurredAt.toISOString());
    expect(result.exit).toBe(logs[2].occurredAt.toISOString());
    expect(result.missingMovements).toEqual(['meal_return']);
    expect(result.issues).toContain('Regreso de comida no registrado.');
    expect(result.status).toBe('incomplete');
    expect(result.mealReturn).toBeUndefined();
    expect(result.mealMinutes).toBeUndefined();
    expect(result.workedMinutes).toBeUndefined();
    expect(result.expectedMealReturn).toBeUndefined();
    expect(result.incidents).toEqual([]);
  });

  it('prioritizes the final work exit over a plausible configured meal return', () => {
    const result = evaluateDay(date, punches(['08:24:06','14:31:42','15:35:11']),
      { ...schedule, mealEnabled: true, mealDetection: 'configured', mealStart: '14:30', mealEnd: '14:30' }, policy, zone, now);
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry','meal_departure','exit']);
    expect(result.missingMovements).toEqual(['meal_return']);
    expect(result.mealMinutes).toBeUndefined();
    expect(result.workedMinutes).toBeUndefined();
    expect(result.incidents.filter((incident) => incident.kind === 'meal_return')).toEqual([]);
  });
});
