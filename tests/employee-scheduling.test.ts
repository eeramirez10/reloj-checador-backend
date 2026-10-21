import { describe, expect, it } from 'vitest';
import { effectiveVersion, resolveEmployeeSchedule, validateEmployeeScheduling, type EmployeeScheduleVersion } from '../src/domain/entities/employee-scheduling.js';
import type { WorkSchedule } from '../src/domain/entities/organization.js';
import { dateAtLocalTime, evaluateDay } from '../src/domain/entities/schedule-evaluator.js';

const date = '2026-10-20';
const zone = 'America/Mexico_City';
const now = new Date('2026-10-21T12:00:00Z');
const base: WorkSchedule = { id: 'base', branchId: 'mexico', name: 'Base', effectiveFrom: '2026-07-31', isDefault: true,
  settings: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30', mealEnabled: false,
    mealStart: '14:00', mealEnd: '15:00', mealDurationMinutes: 60, mealMode: 'individual' } };
const version: EmployeeScheduleVersion = { id: 'version', employeeId: 'employee', effectiveFrom: '2026-07-31', createdAt: now,
  source: 'manual', workHours: null, meal: { enabled: true, startTime: '15:00', endTime: '15:00', durationMinutes: 60 }, recognitionMarginMinutes: 30 };
const policy = { entryToleranceMinutes: 15, mealToleranceMinutes: 15, entryAllowedTardies: 3,
  mealAllowedTardies: 3, accumulationMode: 'first_lateness' as const, accumulationDays: 30 };
function evaluate(times: string[], currentTime = now, selected = version) {
  const resolved = resolveEmployeeSchedule(base, undefined, selected)!;
  return evaluateDay(date, times.map((time, index) => ({ id: `log-${index}`, occurredAt: dateAtLocalTime(date, time, zone), punchState: 0 })),
    resolved.settings, policy, zone, currentTime);
}

describe('independent employee scheduling', () => {
  it('inherits future branch hours while preserving the employee meal configuration', () => {
    const changed = { ...base, settings: { ...base.settings, entryTime: '08:45', exitTime: '17:45' } };
    const resolved = resolveEmployeeSchedule(changed, undefined, version)!;
    expect(resolved.source).toBe('branch');
    expect(resolved.settings).toMatchObject({ entryTime: '08:45', exitTime: '17:45', mealStart: '15:00', mealDurationMinutes: 60 });
  });
  it('gives individual hours priority and can reset them without clearing the meal', () => {
    const special = { ...version, workHours: { workDays: [1,2,3,4,5], entryTime: '09:00', exitTime: '18:00' } };
    expect(resolveEmployeeSchedule(base, undefined, special)!.settings.entryTime).toBe('09:00');
    expect(resolveEmployeeSchedule(base, undefined, version)!.settings).toMatchObject({ entryTime: '08:30', mealStart: '15:00' });
  });
  it('selects the version in effect and excludes superseded base versions', () => {
    const old = { ...base, id: 'old', effectiveFrom: '2026-10-16', supersededFrom: '2026-07-31' };
    expect(effectiveVersion([old, base], date)?.id).toBe('base');
    expect(effectiveVersion([version, { ...version, id: 'future', effectiveFrom: '2026-11-01' }], date)?.id).toBe('version');
  });
  it('does not invent a meal time or meal tardies when configuration is pending', () => {
    const resolved = resolveEmployeeSchedule(base, undefined, undefined)!;
    const result = evaluateDay(date, [{ id: 'entry', occurredAt: dateAtLocalTime(date,'08:30',zone) }], resolved.settings, policy, zone, now);
    expect(result.status).toBe('unconfigured');
    expect(result.mealDeparture).toBeUndefined();
    expect(result.incidents).toEqual([]);
  });
  it('rejects a meal that cannot finish before the applicable workday ends', () => {
    expect(() => validateEmployeeScheduling({ ...version, meal: { enabled: true, startTime: '17:00', endTime: '17:00', durationMinutes: 60 } }, base))
      .toThrow('antes de finalizar');
  });
  it('keeps a stored meal pending if a later inherited workday no longer allows it', () => {
    const shorter = { ...base, settings: { ...base.settings, exitTime: '15:00' } };
    const resolved = resolveEmployeeSchedule(shorter, undefined, version)!;
    expect(resolved.settings).toMatchObject({ mealPending: true, mealEnabled: false, mealStart: '15:00' });
    expect(version.meal?.startTime).toBe('15:00');
  });
});

describe('schedule-aware state transitions', () => {
  it('classifies the real 3039 example even when three punches have entry mode', () => {
    const result = evaluate(['08:40','15:16','15:57','17:33']);
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry','meal_departure','meal_return','exit']);
    expect(result.status).toBe('complete');
  });
  it('keeps a three-hours-later extra punch from shifting the four valid movements', () => {
    const result = evaluate(['08:30','11:30','15:00','16:00','17:30']);
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry','outside_schedule','meal_departure','meal_return','exit']);
    expect(result.missingMovements).toEqual([]);
    expect(result.incidents).toEqual([]);
  });
  it('records a work exit while explicitly leaving the meal return missing', () => {
    const result = evaluate(['08:30','15:00','17:30']);
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry','meal_departure','exit']);
    expect(result.missingMovements).toEqual(['meal_return']);
    expect(result.workedMinutes).toBeUndefined();
  });
  it('waits until the meal return deadline before reporting it missing', () => {
    expect(evaluate(['08:30','15:00'], dateAtLocalTime(date,'15:30',zone)).missingMovements).toEqual([]);
    const overdue = evaluate(['08:30','15:00'], dateAtLocalTime(date,'16:16',zone));
    expect(overdue.missingMovements).toEqual(['meal_return']);
    expect(overdue.incidents).toEqual([]);
  });
  it('identifies a missing work exit after a valid meal return', () => {
    const result = evaluate(['08:30','15:00','16:00']);
    expect(result.missingMovements).toEqual(['exit']);
    expect(result.status).toBe('incomplete');
    expect(result.workedMinutes).toBeUndefined();
  });
  it('recognizes a return at the minimum configurable duration without treating it as a duplicate', () => {
    const shortMeal = { ...version, meal: { enabled: true, startTime: '15:00', endTime: '15:00', durationMinutes: 1 } };
    const result = evaluate(['08:30','15:00','15:01','17:30'], now, shortMeal);
    expect(result.status).toBe('complete');
    expect(result.mealMinutes).toBe(1);
    expect(result.punches[2].movement).toBe('meal_return');
  });
  it('requires review when a lone punch overlaps meal return and work exit windows', () => {
    const lateMeal = { ...version, meal: { enabled: true, startTime: '16:00', endTime: '16:00', durationMinutes: 60 } };
    const result = evaluate(['08:30','16:00','17:15'], now, lateMeal);
    expect(result.status).toBe('ambiguous');
    expect(result.mealReturn).toBeUndefined();
    expect(result.exit).toBeUndefined();
    expect(evaluate(['08:30','16:00','17:15','17:30'], now, lateMeal).status).toBe('complete');
  });
  it('classifies older attendance without applying a future tardiness policy', () => {
    const resolved = resolveEmployeeSchedule(base, undefined, version)!;
    const result = evaluateDay(date, ['08:40','15:16','15:57','17:33'].map((time,index) => ({ id: String(index), occurredAt: dateAtLocalTime(date,time,zone) })), resolved.settings, undefined, zone, now);
    expect(result.status).toBe('complete');
    expect(result.incidents).toEqual([]);
  });
});
