import { describe, expect, it } from 'vitest';
import { dateAtLocalTime, evaluateDay } from '../src/domain/entities/schedule-evaluator.js';
import { resolveEmployeeSchedule, type EmployeeScheduleVersion } from '../src/domain/entities/employee-scheduling.js';
import type { WorkSchedule } from '../src/domain/entities/organization.js';

const date = '2026-10-20';
const zone = 'America/Mexico_City';
const now = new Date('2026-10-21T12:00:00Z');
const base: WorkSchedule = { id: 'base', branchId: 'mexico', name: 'Base', effectiveFrom: '2026-07-31', isDefault: true,
  settings: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30', mealEnabled: true,
    mealStart: '12:00', mealEnd: '12:00', mealDurationMinutes: 10 } };
const policy = { entryToleranceMinutes: 15, mealToleranceMinutes: 15, entryAllowedTardies: 3,
  mealAllowedTardies: 3, accumulationMode: 'first_lateness' as const, accumulationDays: 30 };
const automatic = resolveEmployeeSchedule(base, undefined, undefined)!.settings;
function evaluate(times: string[], settings = automatic, at = now) {
  return evaluateDay(date, times.map((time,index) => ({ id: `log-${index}`, occurredAt: dateAtLocalTime(date,time,zone), punchState: index % 2 })),
    settings, policy, zone, at);
}

describe('automatic meals without an individual schedule', () => {
  it('ignores general meal hours and classifies four chronological punches', () => {
    expect(automatic.mealDetection).toBe('automatic');
    const result = evaluate(['08:40','15:16','15:57','17:33']);
    expect(result.status).toBe('complete');
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry','meal_departure','meal_return','exit']);
    expect(result.mealMinutes).toBe(41);
    expect(result.workedMinutes).toBe(492);
    expect(result.expectedMealReturn).toBeUndefined();
    expect(result.incidents).toEqual([]);
  });

  it('does not penalize an observed long meal using an unconfigured duration', () => {
    const result = evaluate(['06:45','12:00','15:00','20:30']);
    expect(result.mealMinutes).toBe(180);
    expect(result.status).toBe('complete');
    expect(result.incidents).toEqual([]);
  });

  it('counts arrival tardiness independently from inferred meals', () => {
    const result = evaluate(['09:45','13:00','14:30','18:30']);
    expect(result.incidents).toEqual([expect.objectContaining({ kind: 'arrival', minutes: 75 })]);
  });

  it('excludes repeated scans without deleting or renumbering their source records', () => {
    const logs = ['08:30','15:00','16:00','18:30'].map((time,index) => ({ id: `log-${index}`, occurredAt: dateAtLocalTime(date,time,zone) }));
    logs.push({ id: 'duplicate', occurredAt: new Date(logs[0].occurredAt.getTime() + 10_000) });
    const result = evaluateDay(date, logs, automatic, policy, zone, now);
    expect(result.status).toBe('complete');
    expect(result.punches).toHaveLength(5);
    expect(result.punches.find((punch) => punch.id === 'duplicate')?.movement).toBe('duplicate');
  });

  it.each([['08:30'], ['08:30','17:30'], ['08:30','11:30','15:00','16:00','17:30']])
    ('does not invent a complete meal with a different number of punches (%j)', (...times) => {
      const result = evaluate(times);
      expect(result.status).not.toBe('complete');
      expect(result.mealDeparture).toBeUndefined();
      expect(result.mealReturn).toBeUndefined();
      expect(result.workedMinutes).toBeUndefined();
    });

  it('keeps a partial current day in progress until its final movement is identifiable', () => {
    const result = evaluate(['06:45','15:00'], automatic, dateAtLocalTime(date,'15:05',zone));
    expect(result.entry).toBeDefined();
    expect(result.exit).toBeUndefined();
    expect(result.status).toBe('in_progress');
  });

  it('applies personal meal rules only after an employee explicitly configures them', () => {
    const version: EmployeeScheduleVersion = { id: 'personal', employeeId: 'person', effectiveFrom: date, createdAt: now,
      source: 'manual', workHours: null, meal: { enabled: true, startTime: '15:00', endTime: '15:00', durationMinutes: 60 }, recognitionMarginMinutes: 30 };
    const configured = resolveEmployeeSchedule(base, undefined, version)!.settings;
    const result = evaluate(['08:30','15:20','16:40','17:30'], configured);
    expect(configured.mealDetection).toBe('configured');
    expect(result.incidents.map((incident) => incident.kind)).toEqual(['meal_departure','meal_return']);
    expect(result.expectedMealReturn).toBeDefined();
  });

  it('preserves the explicit no-meal setting and does not replace an invalid personal schedule with automatic mode', () => {
    const version: EmployeeScheduleVersion = { id: 'personal', employeeId: 'person', effectiveFrom: date, createdAt: now,
      source: 'manual', workHours: null, meal: { enabled: false, startTime: '00:00', endTime: '00:00', durationMinutes: 60 }, recognitionMarginMinutes: 30 };
    const disabled = resolveEmployeeSchedule(base, undefined, version)!.settings;
    expect(disabled.mealDetection).toBe('disabled');
    expect(evaluate(['06:45','20:30'], disabled).status).toBe('complete');
    const invalid = resolveEmployeeSchedule(base, undefined, { ...version, meal: { enabled: true, startTime: '17:00', endTime: '17:00', durationMinutes: 60 } })!.settings;
    expect(invalid.mealDetection).toBe('invalid');
    expect(evaluate(['08:30','15:00','16:00','17:30'], invalid).status).toBe('unconfigured');
  });
});
