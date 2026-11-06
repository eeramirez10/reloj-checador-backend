import { describe, expect, it } from 'vitest';
import { allocateAdditionalRest, DEFAULT_OVERTIME_SETTINGS, type OvertimeSettings } from '../src/domain/entities/overtime.js';
import { dateAtLocalTime } from '../src/domain/entities/local-date.js';
import { evaluateSubjectAttendance } from '../src/domain/use-cases/evaluate-subject-attendance.js';
import type { EvaluationSnapshot, SubjectLog } from '../src/domain/repositories/evaluation-repository.js';
import type { EmployeeScheduleVersion } from '../src/domain/entities/employee-scheduling.js';
import { overtimeSettingsSchema } from '../src/presentation/validators/overtime.js';
import { summarizeAttendance } from '../src/domain/entities/attendance-summary.js';
import { dailyOvertimeIntervals } from '../src/domain/use-cases/attendance-overtime.js';

const zone = 'America/Mexico_City';
const now = new Date('2026-10-25T12:00:00Z');
const daily: OvertimeSettings = { ...DEFAULT_OVERTIME_SETTINGS, enabled: true };
const route: OvertimeSettings = { ...daily, workMode: 'route' };
function log(date: string, time: string, id = `${date}-${time}`): SubjectLog {
  return { id, employeeId: 'employee', deviceUserId: 'clock-user', subjectId: 'employee', name: 'Persona', employeeNumber: '1',
    userId: '1', branchId: 'branch', occurredAt: dateAtLocalTime(date,time,zone) };
}
function snapshot(settings = daily): EvaluationSnapshot {
  return { branches: [{ id: 'branch', name: 'México', timeZone: zone }], branchAssignments: [], assignments: [], logs: [],
    schedules: [{ id: 'base', branchId: 'branch', name: 'Base', effectiveFrom: '2026-01-01', isDefault: true,
      settings: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30', mealEnabled: false, mealStart: '00:00', mealEnd: '00:00', mealDurationMinutes: 60 } }],
    policies: [{ id: 'policy', branchId: 'branch', effectiveFrom: '2026-01-01', settings: { entryToleranceMinutes: 15, mealToleranceMinutes: 15,
      entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 } }],
    employeeSchedules: [{ id: 'version', employeeId: 'employee', effectiveFrom: '2026-01-01', createdAt: now, source: 'manual', workHours: null,
      meal: { enabled: false, startTime: '00:00', endTime: '00:00', durationMinutes: 60 }, recognitionMarginMinutes: 30, overtime: settings }] };
}
function evaluate(times: string[], settings = daily, data = snapshot(settings)) {
  return evaluateSubjectAttendance(times.map((time) => log('2026-10-19',time)),data,now)[0].daily;
}

describe('overtime outside the branch workday', () => {
  it('counts before and after work separately while preserving first-entry tardiness', () => {
    const late = evaluate(['08:50','21:00']);
    expect(late.overtime).toMatchObject({ grossSeconds: 12600, netSeconds: 12600, beforeSeconds: 0, afterSeconds: 12600 });
    expect(late.incidents).toEqual([expect.objectContaining({ kind: 'arrival', minutes: 20 })]);
    const early = evaluate(['05:30','21:00']);
    expect(early.overtime).toMatchObject({ beforeSeconds: 10800, afterSeconds: 12600, netSeconds: 23400 });
    expect(early.incidents).toEqual([]);
  });
  it('always uses the branch reference even when personal work hours differ', () => {
    const data = snapshot();
    data.employeeSchedules[0].workHours = { workDays: [1,2,3,4,5], entryTime: '09:00', exitTime: '18:00' };
    const result = evaluate(['08:50','21:00'],daily,data);
    expect(result.overtime?.referenceEntryTime).toBe('08:30');
    expect(result.overtime?.afterSeconds).toBe(12600);
    expect(result.incidents[0].minutes).toBe(20);
    expect(data.employeeSchedules[0].workHours.entryTime).toBe('09:00');
  });
  it('calculates overtime independently of missing meal punches without inventing worked hours or meal movements', () => {
    expect(evaluate(['08:30','21:00'],DEFAULT_OVERTIME_SETTINGS).overtime).toBeUndefined();
    const data = snapshot();
    data.employeeSchedules[0].meal = null;
    const result = evaluate(['08:30','21:00'],daily,data);
    expect(result.overtime).toMatchObject({ status: 'calculated', beforeSeconds: 0, afterSeconds: 12600, netSeconds: 12600 });
    expect(result.status).toBe('incomplete');
    expect(result.missingMovements).toEqual(['meal_departure','meal_return']);
    expect(result.workedMinutes).toBeUndefined();
    expect(result.mealDeparture).toBeUndefined(); expect(result.mealReturn).toBeUndefined();
    expect(result.punches.map((punch) => punch.movement)).toEqual(['entry','exit']);
  });
  it('calculates with one missing meal movement, preserving tardiness and the incomplete workday', () => {
    const data = snapshot(); data.employeeSchedules[0].meal = null;
    const result = evaluate(['08:50','13:00','21:00'],daily,data);
    expect(result.overtime).toMatchObject({ status: 'calculated', netSeconds: 12600 });
    expect(result.status).toBe('incomplete');
    expect(result.mealDeparture).toBeDefined(); expect(result.mealReturn).toBeUndefined();
    expect(result.workedMinutes).toBeUndefined();
    expect(result.missingMovements).toEqual(['meal_return']);
    expect(result.incidents).toEqual([expect.objectContaining({ kind: 'arrival', minutes: 20 })]);
  });
  it('uses confirmed entry and exit even when meal recognition is configured, invalid or ambiguous', () => {
    const data = snapshot();
    data.employeeSchedules[0].meal = { enabled: true, startTime: '13:00', endTime: '13:00', durationMinutes: 60 };
    const configured = evaluate(['05:30','21:00'],daily,data);
    expect(configured.overtime).toMatchObject({ status: 'calculated', netSeconds: 23400 });
    expect(configured.status).toBe('incomplete'); expect(configured.workedMinutes).toBeUndefined();
    data.employeeSchedules[0].meal.endTime = '17:30';
    const invalid = evaluate(['05:30','21:00'],daily,data);
    expect(invalid.status).toBe('unconfigured');
    expect(invalid.overtime).toMatchObject({ status: 'calculated', netSeconds: 23400 });
    expect(invalid.workedMinutes).toBeUndefined();
    data.employeeSchedules[0].meal = null;
    const ambiguous = evaluate(['05:30','12:00','13:00','14:00','15:00','21:00'],daily,data);
    expect(ambiguous.status).toBe('ambiguous');
    expect(ambiguous.overtime).toMatchObject({ status: 'calculated', netSeconds: 23400 });
    expect(ambiguous.workedMinutes).toBeUndefined();
  });
  it('keeps missing work boundaries or branch references pending and rejects invalid or reversed intervals', () => {
    const open = evaluate(['08:30']);
    expect(open.overtime).toMatchObject({ status: 'pending', netSeconds: null });
    const data = snapshot(); data.schedules = [];
    expect(evaluate(['08:30','21:00'],daily,data).overtime).toMatchObject({ status: 'pending', issue: 'Falta una jornada de sucursal vigente.' });
    const closed = evaluate(['08:30','21:00']);
    expect(dailyOvertimeIntervals({ ...closed, entry: undefined })).toBeNull();
    expect(dailyOvertimeIntervals({ ...closed, exit: closed.entry })).toBeNull();
    expect(dailyOvertimeIntervals({ ...closed, entry: closed.exit, exit: closed.entry })).toBeNull();
    expect(dailyOvertimeIntervals({ ...closed, exit: 'invalid' })).toBeNull();
  });
  it('applies both rest discounts and day-off overtime without requiring meal marks or completing worked hours', () => {
    const settings = { ...daily, restEnabled: true, dailyRest: { startTime: '20:00', endTime: '21:00' }, additionalRestMinutes: 30 };
    const data = snapshot(settings); data.employeeSchedules[0].meal = null;
    const result = evaluate(['05:30','21:00'],settings,data);
    expect(result.overtime).toMatchObject({ grossSeconds: 23400, dailyRestSeconds: 3600, additionalRestSeconds: 1800, netSeconds: 18000 });
    expect(result.workedMinutes).toBeUndefined();
    const off = evaluateSubjectAttendance([log('2026-10-24','05:30'),log('2026-10-24','21:00')],data,now)[0].daily;
    expect(off.overtime).toMatchObject({ status: 'calculated', dayOffSeconds: 55800, netSeconds: 50400 });
    expect(off.workedMinutes).toBeUndefined();
  });
  it('excludes recorded meals and does not subtract overlapping rests twice', () => {
    const settings = { ...daily, restEnabled: true, dailyRest: { startTime: '17:00', endTime: '19:00' } };
    const data = snapshot(settings);
    data.employeeSchedules[0].meal = { enabled: true, startTime: '16:50', endTime: '16:50', durationMinutes: 30 };
    data.employeeSchedules[0].recognitionMarginMinutes = 60;
    data.schedules[0].settings.exitTime = '19:30';
    const result = evaluate(['08:30','16:50','18:00','21:00'],settings,data);
    expect(result.overtime).toMatchObject({ grossSeconds: 5400, dailyRestSeconds: 0, netSeconds: 5400 });
    data.schedules[0].settings.exitTime = '17:30';
    const overlapping = evaluate(['08:30','16:50','18:00','21:00'],settings,data);
    expect(overlapping.overtime).toMatchObject({ grossSeconds: 10800, dailyRestSeconds: 3600, netSeconds: 7200 });
  });
  it('counts scheduled days off fully and honors configured Saturday workdays', () => {
    const logs = [log('2026-10-24','05:30'),log('2026-10-24','21:00')];
    const data = snapshot();
    expect(evaluateSubjectAttendance(logs,data,now)[0].daily.overtime).toMatchObject({ dayOffSeconds: 55800, netSeconds: 55800 });
    data.schedules[0].settings.workDays.push(6);
    expect(evaluateSubjectAttendance(logs,data,now)[0].daily.overtime).toMatchObject({ dayOffSeconds: 0, netSeconds: 23400 });
  });
  it('caps additional rest at the available overtime and preserves exact seconds', () => {
    expect(evaluate(['08:30','21:00'],{ ...daily, restEnabled: true, additionalRestMinutes: 1000 }).overtime?.netSeconds).toBe(0);
    const logs = [log('2026-10-19','05:30'),log('2026-10-19','21:00')];
    logs[0].occurredAt = new Date(logs[0].occurredAt.getTime() + 15000);
    logs[1].occurredAt = new Date(logs[1].occurredAt.getTime() + 5000);
    expect(evaluateSubjectAttendance(logs,snapshot(),now)[0].daily.overtime?.netSeconds).toBe(23390);
  });
});

describe('deductible branch overtime margins', () => {
  function withMargins(entry = 30, exit = 30, settings = daily) {
    const data = snapshot(settings);
    data.policies[0].settings.overtimeEntryMarginMinutes = entry;
    data.policies[0].settings.overtimeExitMarginMinutes = exit;
    return data;
  }

  it('counts only time beyond each margin, including zero at the exact boundary', () => {
    expect(evaluate(['08:00','18:00'],daily,withMargins()).overtime).toMatchObject({ beforeSeconds: 0, afterSeconds: 0, netSeconds: 0, entryMarginMinutes: 30, exitMarginMinutes: 30 });
    expect(evaluate(['07:00','18:30'],daily,withMargins()).overtime).toMatchObject({ beforeSeconds: 3600, afterSeconds: 1800, grossSeconds: 5400, netSeconds: 5400 });
    const precise = [log('2026-10-19','08:00'),log('2026-10-19','18:00')];
    precise[0].occurredAt = new Date(precise[0].occurredAt.getTime() - 1000);
    precise[1].occurredAt = new Date(precise[1].occurredAt.getTime() + 1000);
    expect(evaluateSubjectAttendance(precise,withMargins(),now)[0].daily.overtime).toMatchObject({ beforeSeconds: 1, afterSeconds: 1, netSeconds: 2 });
  });

  it('supports separate entry and exit margins and retains the original result when they are absent or zero', () => {
    expect(evaluate(['07:00','19:00'],daily,withMargins(15,45)).overtime).toMatchObject({ beforeSeconds: 4500, afterSeconds: 2700, netSeconds: 7200 });
    expect(evaluate(['07:00','18:30'],daily,withMargins(0,0)).overtime).toEqual(evaluate(['07:00','18:30']).overtime);
  });

  it('does not alter work hours, arrival tardiness or incomplete meal validation', () => {
    const early = evaluate(['07:00','18:30'],daily,withMargins());
    expect(early.workedMinutes).toBe(690);
    const data = withMargins(); data.employeeSchedules[0].meal = null;
    const late = evaluate(['09:00','18:00'],daily,data);
    expect(late.incidents).toEqual([expect.objectContaining({ kind: 'arrival', minutes: 30 })]);
    expect(late.overtime).toMatchObject({ status: 'calculated', netSeconds: 0, referenceEntryTime: '08:30', referenceExitTime: '17:30' });
    expect(late.missingMovements).toEqual(['meal_departure','meal_return']); expect(late.workedMinutes).toBeUndefined();
  });

  it('does not double-discount overlapping rest and margin intervals and applies additional rest afterward', () => {
    const settings = { ...daily, restEnabled: true, dailyRest: { startTime: '17:45', endTime: '18:15' }, additionalRestMinutes: 20 };
    const day = evaluate(['08:00','20:00'],settings,withMargins(30,30,settings));
    expect(day.overtime).toMatchObject({ grossSeconds: 7200, dailyRestSeconds: 900, additionalRestSeconds: 1200, netSeconds: 5100 });
    expect(day.workedMinutes).toBe(670);
  });

  it('applies no entry or exit margin on scheduled days off', () => {
    const result = evaluateSubjectAttendance([log('2026-10-24','07:00'),log('2026-10-24','18:30')],withMargins(),now)[0].daily;
    expect(result.overtime).toMatchObject({ dayOffSeconds: 41400, netSeconds: 41400, entryMarginMinutes: 0, exitMarginMinutes: 0 });
  });

  it('resolves margins by policy date for daily work and every daily route segment', () => {
    const data = snapshot();
    data.policies.push({ ...data.policies[0], id: 'margins', effectiveFrom: '2026-10-20', settings: {
      ...data.policies[0].settings, overtimeEntryMarginMinutes: 30, overtimeExitMarginMinutes: 30 } });
    const logs = ['2026-10-19','2026-10-20'].flatMap((date) => [log(date,'07:00'),log(date,'18:30')]);
    const days = evaluateSubjectAttendance(logs,data,now);
    expect(days.map((day) => day.daily.overtime?.netSeconds)).toEqual([9000,5400]);
    data.employeeSchedules[0].overtime = route;
    const journey = evaluateSubjectAttendance([log('2026-10-19','07:00'),log('2026-10-21','18:30')],data,now);
    expect(journey.map((day) => day.daily.overtime?.netSeconds)).toEqual([28800,50400,30600]);
    expect(journey.reduce((sum,day) => sum + day.daily.workedMinutes!,0)).toBe(3570);
  });

  it('does not deduct the same margin repeatedly for several routes on the same date', () => {
    const data = withMargins(30,30,route);
    const result = evaluateSubjectAttendance(['05:00','06:00','07:00','08:30'].map((time) => log('2026-10-19',time)),data,now)[0].daily;
    expect(result.routes).toHaveLength(2);
    expect(result.overtime).toMatchObject({ beforeSeconds: 7200, netSeconds: 7200 });
    expect(result.workedMinutes).toBe(150);
  });
});

describe('multi-day routes', () => {
  it('keeps nights in the route, creates daily derived segments and never fabricates punches', () => {
    const logs = [log('2026-10-19','08:50'),log('2026-10-21','21:00')];
    const result = evaluateSubjectAttendance(logs,snapshot(route),now);
    expect(result.map((day) => day.date)).toEqual(['2026-10-19','2026-10-20','2026-10-21']);
    expect(result.flatMap((day) => day.daily.punches).map((punch) => punch.id)).toEqual(logs.map((item) => item.id));
    expect(result[1].daily).toMatchObject({ status: 'complete', punches: [], workedMinutes: 1440 });
    expect(result[2].daily.entry).toBeUndefined();
    expect(result[2].daily.exit).toBe(logs[1].occurredAt.toISOString());
    expect(result.flatMap((day) => day.daily.incidents)).toEqual([expect.objectContaining({ minutes: 20, logId: logs[0].id })]);
    expect(result.reduce((sum,day) => sum + day.daily.overtime!.netSeconds!,0)).toBe(120600);
  });
  it('supports both rest modes and applies the additional amount only once across all dates', () => {
    const settings: OvertimeSettings = { ...route, restEnabled: true, dailyRest: { startTime: '22:00', endTime: '06:00' }, additionalRestMinutes: 120 };
    const result = evaluateSubjectAttendance([log('2026-10-19','08:30'),log('2026-10-21','21:00')],snapshot(settings),now);
    const sum = (key: 'grossSeconds' | 'dailyRestSeconds' | 'additionalRestSeconds' | 'netSeconds') => result.reduce((total,day) => total + day.daily.overtime![key]!,0);
    expect(sum('grossSeconds')).toBe(120600);
    expect(sum('dailyRestSeconds')).toBe(57600);
    expect(sum('additionalRestSeconds')).toBe(7200);
    expect(sum('netSeconds')).toBe(55800);
    expect(result.reduce((total,day) => total + day.daily.workedMinutes!,0)).toBe(2550);
    expect(result.every((day) => day.daily.overtime!.netSeconds! >= 0)).toBe(true);
  });
  it('leaves open routes pending even after multiple days and does not invent a closing time', () => {
    const result = evaluateSubjectAttendance([log('2026-10-19','08:30')],snapshot(route),new Date('2026-10-22T12:00:00Z'));
    expect(result).toHaveLength(4);
    expect(result.every((day) => day.daily.status === 'in_progress' && day.daily.workedMinutes === undefined && day.daily.overtime?.netSeconds === null)).toBe(true);
    expect(result.every((day) => day.daily.routes?.[0].exitedAt === null && day.daily.exit === undefined)).toBe(true);
  });
  it('keeps repeated scans, supports more than two days and counts weekends as outside the branch workday', () => {
    const logs = [log('2026-10-16','08:30'),log('2026-10-16','08:36'),log('2026-10-19','21:00')];
    const result = evaluateSubjectAttendance(logs,snapshot(route),now);
    expect(result).toHaveLength(4);
    expect(result[0].daily.punches.map((punch) => punch.movement)).toEqual(['entry','duplicate']);
    expect(result.reduce((total,day) => total + day.daily.overtime!.dayOffSeconds!,0)).toBe(172800);
    expect(result.reduce((total,day) => total + day.daily.overtime!.netSeconds!,0)).toBe(239400);
  });
  it('preserves sub-minute duplicates with a disabled repeat margin and stops opening routes when disabled', () => {
    const data = snapshot(route);
    data.policies[0].settings.entryRepeatWindowMinutes = 0;
    const first = log('2026-10-19','08:30');
    const repeated = { ...first, id: 'repeated', occurredAt: new Date(first.occurredAt.getTime() + 30000) };
    const logs = [first,repeated,log('2026-10-21','21:00')];
    expect(evaluateSubjectAttendance(logs,data,now)[0].daily.punches.map((punch) => punch.movement)).toEqual(['entry','duplicate']);
    const disabled = { ...route, enabled: false };
    const stopped = snapshot(disabled);
    stopped.employeeSchedules[0].workHours = { workDays: [1,2,3,4,5], entryTime: '09:00', exitTime: '18:00' };
    const result = evaluateSubjectAttendance([log('2026-10-19','09:00'),log('2026-10-19','18:00')],stopped,now);
    expect(result[0].daily.routes).toBeUndefined();
    expect(result[0].schedule?.settings.entryTime).toBe('09:00');
    expect(result[0].daily.overtime).toBeUndefined();
  });
  it('uses dated branch hours and keeps a missing reference pending for the entire additional-rest allocation', () => {
    const data = snapshot(route);
    data.schedules.push({ ...data.schedules[0], id: 'new-base', effectiveFrom: '2026-10-20', settings: { ...data.schedules[0].settings, exitTime: '18:30' } });
    const logs = [log('2026-10-19','08:30'),log('2026-10-21','21:00')];
    const result = evaluateSubjectAttendance(logs,data,now);
    expect(result.reduce((total,day) => total + day.daily.overtime!.netSeconds!,0)).toBe(113400);
    data.schedules = [];
    expect(evaluateSubjectAttendance(logs,data,now).every((day) => day.daily.overtime?.status === 'pending')).toBe(true);
  });
  it('uses dated employee enablement and branch-local midnight boundaries', () => {
    const data = snapshot(route);
    data.branches[0].timeZone = 'America/Cancun';
    const logs = [log('2026-10-19','08:30'),log('2026-10-21','21:00')];
    const result = evaluateSubjectAttendance(logs,data,now);
    expect(result[0].daily.overtime?.referenceEntryTime).toBe('08:30');
    expect(result[0].daily.punches[0].localTime).toBe('2026-10-19 09:30:00');
    data.employeeSchedules.push({ ...data.employeeSchedules[0], id: 'disabled', effectiveFrom: '2026-10-20', overtime: { ...route, enabled: false } } satisfies EmployeeScheduleVersion);
    expect(evaluateSubjectAttendance(logs,data,now).filter((day) => day.daily.overtime)).toHaveLength(1);
  });
  it('closes an existing route after disabling extras and preserves later daily work sessions on the return date', () => {
    const data = snapshot(route);
    data.employeeSchedules.push({ ...data.employeeSchedules[0], id: 'disabled', effectiveFrom: '2026-10-21',
      overtime: { ...route, enabled: false } });
    const logs = [log('2026-10-19','08:30'),log('2026-10-21','07:00'),log('2026-10-21','09:00'),log('2026-10-21','18:00'),
      log('2026-10-22','09:00'),log('2026-10-22','18:00')];
    const result = evaluateSubjectAttendance(logs,data,now);
    const returned = result.find((item) => item.date === '2026-10-21')!.daily;
    expect(returned.workedMinutes).toBe(960);
    expect(returned.overtime).toBeUndefined();
    expect(result.find((item) => item.date === '2026-10-22')!.daily.routes).toBeUndefined();
    const summary = summarizeAttendance([returned])[0];
    expect(summary.sessions).toHaveLength(2);
    expect(summary.sessions.map((item) => item.workedMinutes)).toEqual([420,540]);
    expect(summary.sessions[0].inferredFromRoute).toBe(true);
    expect(summary.sessions[1].entry).toEqual(logs[2].occurredAt);
  });
});

describe('overtime settings and proportional additional rests', () => {
  it('validates settings, permits crossing midnight and rejects an undefined rest or equal endpoints', () => {
    expect(overtimeSettingsSchema.safeParse({ ...route, restEnabled: true }).success).toBe(false);
    expect(overtimeSettingsSchema.safeParse({ ...route, restEnabled: true, dailyRest: { startTime: '22:00', endTime: '06:00' } }).success).toBe(true);
    expect(overtimeSettingsSchema.safeParse({ ...route, restEnabled: true, dailyRest: { startTime: '06:00', endTime: '06:00' } }).success).toBe(false);
  });
  it('allocates exactly once without losing seconds, exceeding capacities or creating negative time', () => {
    expect(allocateAdditionalRest([1,1,1],2)).toEqual([1,1,0]);
    expect(allocateAdditionalRest([10,20,30],1000)).toEqual([10,20,30]);
    expect(allocateAdditionalRest([0,0],120)).toEqual([0,0]);
    const parts = allocateAdditionalRest([16200,25200,21600],7200);
    expect(parts.reduce((sum,value) => sum + value,0)).toBe(7200);
    expect(parts).toEqual([1851,2880,2469]);
  });
});
