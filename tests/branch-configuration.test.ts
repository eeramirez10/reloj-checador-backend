import { describe, expect, it } from 'vitest';
import { resolveEmployeeSchedule, type EmployeeScheduleVersion } from '../src/domain/entities/employee-scheduling.js';
import type { WorkSchedule } from '../src/domain/entities/organization.js';
import { branchConfigurationSchema } from '../src/presentation/validators/branch-configuration.js';
import { policySettingsSchema } from '../src/presentation/validators/organization.js';
import { preserveOvertimeMargins } from '../src/domain/entities/organization.js';

const base: WorkSchedule = { id: 'base', branchId: 'branch', name: 'Base', effectiveFrom: '2025-01-01', isDefault: true,
  settings: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30', mealEnabled: false, mealStart: '00:00',
    mealEnd: '00:00', mealDurationMinutes: 60, recognitionMarginMinutes: 45,
    branchMeal: { mode: 'configured', startTime: '13:30', endTime: '13:30', durationMinutes: 60 } } };
const personal: EmployeeScheduleVersion = { id: 'person', employeeId: 'employee', effectiveFrom: '2025-01-01', createdAt: new Date(),
  source: 'manual', workHours: null, meal: null, recognitionMarginMinutes: 30 };

describe('unified branch meal inheritance', () => {
  it('validates independent overtime margins and preserves them when legacy requests omit the fields', () => {
    const policy = { entryToleranceMinutes: 15, mealToleranceMinutes: 15, entryAllowedTardies: 3, mealAllowedTardies: 3,
      accumulationMode: 'first_lateness' as const, accumulationDays: 30 };
    expect(policySettingsSchema.parse({ ...policy, overtimeEntryMarginMinutes: 30, overtimeExitMarginMinutes: 45 })).toMatchObject({ overtimeEntryMarginMinutes: 30, overtimeExitMarginMinutes: 45 });
    for (const value of [-1, 241, 0.5, '30', null]) {
      expect(policySettingsSchema.safeParse({ ...policy, overtimeEntryMarginMinutes: value }).success).toBe(false);
      expect(policySettingsSchema.safeParse({ ...policy, overtimeExitMarginMinutes: value }).success).toBe(false);
    }
    const previous = { ...policy, overtimeEntryMarginMinutes: 30, overtimeExitMarginMinutes: 45 };
    expect(preserveOvertimeMargins(policy, previous)).toMatchObject({ overtimeEntryMarginMinutes: 30, overtimeExitMarginMinutes: 45 });
    expect(preserveOvertimeMargins({ ...policy, overtimeExitMarginMinutes: 0 }, previous)).toMatchObject({ overtimeEntryMarginMinutes: 30, overtimeExitMarginMinutes: 0 });
  });
  it('inherits branch meal and recognition settings when there is no personal override', () => {
    expect(resolveEmployeeSchedule(base, undefined, undefined)?.settings).toMatchObject({ mealDetection: 'configured', mealSource: 'branch', mealStart: '13:30', recognitionMarginMinutes: 45 });
    expect(resolveEmployeeSchedule(base, undefined, { ...personal, mealMode: 'inherit', recognitionMarginInherited: true })?.settings)
      .toMatchObject({ mealDetection: 'configured', recognitionMarginMinutes: 45 });
  });
  it('preserves legacy automatic meals and explicit personal meal rules', () => {
    expect(resolveEmployeeSchedule(base, undefined, personal)?.settings).toMatchObject({ mealDetection: 'automatic', recognitionMarginMinutes: 30 });
    expect(resolveEmployeeSchedule(base, undefined, { ...personal, meal: { enabled: true, startTime: '14:00', endTime: '15:00', durationMinutes: 60 } })?.settings)
      .toMatchObject({ mealDetection: 'configured', mealStart: '14:00', mealEnd: '15:00', mealSource: 'individual' });
  });
  it('preserves legacy assigned recognition margins until unified branch settings are configured', () => {
    const assigned = { ...base, id: 'assigned', settings: { ...base.settings, branchMeal: undefined, recognitionMarginMinutes: 10 } };
    const legacyBase = { ...base, settings: { ...base.settings, branchMeal: undefined } };
    expect(resolveEmployeeSchedule(legacyBase, assigned, undefined)?.settings.recognitionMarginMinutes).toBe(10);
    expect(resolveEmployeeSchedule(base, assigned, undefined)?.settings.recognitionMarginMinutes).toBe(45);
  });
  it('keeps automatic and disabled modes independent of a fixed branch meal', () => {
    expect(resolveEmployeeSchedule(base, undefined, { ...personal, mealMode: 'automatic' })?.settings.mealDetection).toBe('automatic');
    expect(resolveEmployeeSchedule(base, undefined, { ...personal, mealMode: 'individual', meal: { enabled: false, startTime: '00:00', endTime: '00:00', durationMinutes: 60 } })?.settings.mealDetection).toBe('disabled');
    expect(resolveEmployeeSchedule({ ...base, settings: { ...base.settings, branchMeal: { ...base.settings.branchMeal!, mode: 'disabled' } } }, undefined, undefined)?.settings.mealDetection).toBe('disabled');
  });
  it('flags inherited meals incompatible with personal work hours instead of changing those hours', () => {
    const resolved = resolveEmployeeSchedule(base, undefined, { ...personal, mealMode: 'inherit', workHours: { workDays: [1,2,3,4,5], entryTime: '08:00', exitTime: '14:00' } });
    expect(resolved?.settings).toMatchObject({ entryTime: '08:00', exitTime: '14:00', mealDetection: 'invalid', mealPending: true });
  });
  it('validates the complete branch workday and meal duration together', () => {
    const input = { effectiveFrom: '2025-01-01', workHours: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30' },
      meal: base.settings.branchMeal, recognitionMarginMinutes: 30, policy: { entryToleranceMinutes: 15, mealToleranceMinutes: 15,
        entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 } };
    expect(branchConfigurationSchema.safeParse(input).success).toBe(true);
    expect(branchConfigurationSchema.safeParse({ ...input, workHours: { ...input.workHours, exitTime: '08:00' } }).success).toBe(false);
    expect(branchConfigurationSchema.safeParse({ ...input, meal: { ...input.meal, startTime: '17:00', endTime: '17:00' } }).success).toBe(false);
    expect(branchConfigurationSchema.safeParse({ ...input, recognitionMarginMinutes: -1 }).success).toBe(false);
  });
});
