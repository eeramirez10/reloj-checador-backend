import { describe, expect, it } from 'vitest';
import { accumulateIncidents, dateAtLocalTime, evaluateDay, type CountedIncident } from '../src/domain/entities/schedule-evaluator.js';
import { policySettingsSchema, scheduleSettingsSchema, type PolicySettings, type ScheduleSettings } from '../src/presentation/validators/organization.js';

const zone = 'America/Mexico_City';
const date = '2026-10-26';
const now = new Date('2026-10-27T12:00:00Z');
const schedule: ScheduleSettings = { workDays: [1, 2, 3, 4, 5], entryTime: '08:30', exitTime: '18:00', mealEnabled: true, mealStart: '14:00', mealEnd: '15:00', mealDurationMinutes: 60 };
const policy: PolicySettings = { entryToleranceMinutes: 0, mealToleranceMinutes: 0, entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 };
function logs(times: string[]) { return times.map((time, index) => ({ id: `log-${index}`, occurredAt: dateAtLocalTime(date, time, zone) })); }
function incident(day: string, kind: CountedIncident['kind'] = 'arrival', settings = policy, id = `${day}-${kind}`): CountedIncident {
  return { id, policyId: 'policy-1', date: day, kind, settings, occurredAt: `${day}T15:00:00Z` };
}

describe('schedule-based attendance', () => {
  it('calculates lunch return from actual departure rather than the end of the departure window', () => {
    const result = evaluateDay(date, logs(['08:30', '14:30', '15:30', '18:00']), schedule, policy, zone, now);
    expect(result.status).toBe('complete');
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry', 'meal_departure', 'meal_return', 'exit']);
    expect(result.expectedMealReturn).toBe(dateAtLocalTime(date, '15:30', zone).toISOString());
    expect(result.incidents).toEqual([]);
    expect(result.workedMinutes).toBe(510);
  });

  it('counts departure and return as two independent meal tardies', () => {
    const result = evaluateDay(date, logs(['08:31', '15:10', '16:11', '18:00']), schedule, policy, zone, now);
    expect(result.incidents.map((value) => [value.kind, value.minutes])).toEqual([['arrival', 1], ['meal_departure', 10], ['meal_return', 1]]);
  });

  it('respects both tolerance boundaries, including seconds with zero tolerance', () => {
    const within = evaluateDay(date, logs(['08:35', '15:05', '16:10', '18:00']), schedule, { ...policy, entryToleranceMinutes: 5, mealToleranceMinutes: 5 }, zone, now);
    expect(within.incidents).toHaveLength(0);
    const punches = logs(['08:30', '14:30', '15:30', '18:00']);
    punches[0].occurredAt = new Date(punches[0].occurredAt.getTime() + 1000);
    expect(evaluateDay(date, punches, schedule, policy, zone, now).incidents[0].kind).toBe('arrival');
  });

  it('does not treat a final punch as an assumed late lunch return when a punch is missing', () => {
    const result = evaluateDay(date, logs(['08:30', '14:30', '18:00']), schedule, policy, zone, now);
    expect(result.status).toBe('incomplete');
    expect(result.mealReturn).toBeUndefined();
    expect(result.exit).toBe(dateAtLocalTime(date, '18:00', zone).toISOString());
    expect(result.missingMovements).toContain('meal_return');
    expect(result.incidents).toHaveLength(0);
  });

  it('keeps a two-punch day incomplete when lunch punches are required', () => {
    const result = evaluateDay(date, logs(['08:30', '18:00']), schedule, policy, zone, now);
    expect(result.status).toBe('incomplete');
    expect(result.mealDeparture).toBeUndefined();
    expect(result.exit).toBeDefined();
  });

  it('handles employees without lunch punches and distinguishes unexpected extra movements', () => {
    expect(evaluateDay(date, logs(['08:30', '18:00']), { ...schedule, mealEnabled: false }, policy, zone, now).status).toBe('complete');
    expect(evaluateDay(date, logs(['08:30', '12:00', '18:00']), { ...schedule, mealEnabled: false }, policy, zone, now).status).toBe('ambiguous');
  });

  it('ignores repeated scans within a minute without discarding the source punch', () => {
    const punches = logs(['08:30', '14:30', '15:30', '18:00']);
    punches.push({ id: 'duplicate', occurredAt: new Date(punches[0].occurredAt.getTime() + 10000) });
    const result = evaluateDay(date, punches, schedule, policy, zone, now);
    expect(result.status).toBe('complete');
    expect(result.punches.find((punch) => punch.id === 'duplicate')?.movement).toBe('duplicate');
  });

  it('does not penalize days off or invent an entry from an afternoon-only punch', () => {
    expect(evaluateDay(date, logs(['08:31', '18:00']), { ...schedule, workDays: [6] }, policy, zone, now).incidents).toHaveLength(0);
    expect(evaluateDay(date, logs(['14:30', '18:00']), schedule, policy, zone, now).status).toBe('ambiguous');
  });

  it('keeps an unfinished current workday in progress', () => {
    expect(evaluateDay(date, logs(['08:30', '14:30']), schedule, policy, zone, dateAtLocalTime(date, '14:45', zone)).status).toBe('in_progress');
  });
});

describe('tardy groups and deductions', () => {
  it('does not reset a first-lateness period when the calendar month changes', () => {
    const values = ['2026-10-28', '2026-11-03', '2026-11-04', '2026-11-05'].map((day) => incident(day));
    const result = accumulateIncidents(values, '2026-11-05');
    expect(result.deductions).toHaveLength(1);
    expect(result.deductions[0]).toMatchObject({ windowStart: '2026-10-28', windowEnd: '2026-11-27', triggerIncidentId: '2026-11-05-arrival' });
    expect(result.remaining.arrival).toBe(0);
  });

  it('expires after exactly 30 calendar days and supports calendar-month resets', () => {
    const dates = ['2026-10-28', '2026-11-27'];
    expect(accumulateIncidents(dates.map((day) => incident(day)), '2026-11-27').remaining.arrival).toBe(1);
    const monthPolicy = { ...policy, accumulationMode: 'calendar_month' as const };
    expect(accumulateIncidents(['2026-10-28', '2026-11-03'].map((day) => incident(day, 'arrival', monthPolicy)), '2026-11-03').remaining.arrival).toBe(1);
  });

  it('keeps arrival and meal counters separate and consumes each group only once', () => {
    const values = [incident('2026-10-26'), incident('2026-10-27'), incident('2026-10-26', 'meal_departure'), incident('2026-10-26', 'meal_return')];
    expect(accumulateIncidents(values, '2026-10-27')).toMatchObject({ deductions: [], remaining: { arrival: 2, meal: 2 } });
    const eight = Array.from({ length: 8 }, (_, index) => incident(`2026-11-${String(index + 1).padStart(2, '0')}`));
    const result = accumulateIncidents(eight, '2026-11-08');
    expect(result.deductions).toHaveLength(2);
    expect(new Set(result.deductions.flatMap((item) => item.incidentIds)).size).toBe(8);
    expect(accumulateIncidents(eight, '2026-11-08')).toEqual(result);
  });

  it('supports a double meal tardy completing one group and starting the next', () => {
    const values = [incident('2026-10-26', 'meal_departure'), incident('2026-10-27', 'meal_return'), incident('2026-10-28', 'meal_return'),
      incident('2026-10-29', 'meal_departure'), incident('2026-10-29', 'meal_return')];
    const result = accumulateIncidents(values, '2026-10-29');
    expect(result.deductions).toHaveLength(1);
    expect(result.remaining.meal).toBe(1);
  });

  it('preserves accumulated tardies across policy versions', () => {
    const values = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map((day, index) => ({ ...incident(day), policyId: index < 2 ? 'old-policy' : 'new-policy' }));
    expect(accumulateIncidents(values, '2026-10-29').deductions).toHaveLength(1);
  });
});

describe('schedule validation', () => {
  it('rejects inverted windows, invalid days and negative tolerances', () => {
    expect(scheduleSettingsSchema.safeParse({ ...schedule, mealStart: '16:00', mealEnd: '15:00' }).success).toBe(false);
    expect(scheduleSettingsSchema.safeParse({ ...schedule, workDays: [1, 1] }).success).toBe(false);
    expect(policySettingsSchema.safeParse({ ...policy, mealToleranceMinutes: -1 }).success).toBe(false);
  });
});
