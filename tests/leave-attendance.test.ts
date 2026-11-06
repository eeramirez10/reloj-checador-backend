import { describe, expect, it } from 'vitest';
import { applyLeaveAuthorizations, authorizedSchedule, unauthorizedEarlyExit } from '../src/domain/entities/leave-attendance.js';
import { dateAtLocalTime } from '../src/domain/entities/local-date.js';
import { evaluateDay } from '../src/domain/entities/schedule-evaluator.js';
import type { LeaveAuthorization } from '../src/domain/entities/leave.js';
import type { PolicySettings, ScheduleSettings } from '../src/domain/entities/organization.js';

const zone = 'America/Mexico_City';
const date = '2026-10-12';
const instant = (time: string) => dateAtLocalTime(date, time, zone).toISOString();
const schedule: ScheduleSettings = { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30', mealEnabled: true, mealStart: '13:00', mealEnd: '13:00', mealDurationMinutes: 60, mealDetection: 'configured' };
const policy: PolicySettings = { entryToleranceMinutes: 5, mealToleranceMinutes: 5, entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'calendar_month', accumulationDays: 30 };
const arrival: LeaveAuthorization = { requestId: 'request', kind: 'late_arrival', authorizedTime: '10:00', start: instant('08:30'), end: instant('10:00'), paid: true, useVacation: false, reason: 'Cita' };

describe('authorized attendance intervals', () => {
  it('does not extend an approved arrival interval when the historical schedule later starts earlier', () => {
    const changed = { ...schedule, entryTime: '07:30', mealEnabled: false, mealDetection: 'disabled' as const };
    const day = evaluateDay(date, [{ id: 'entry', occurredAt: new Date(instant('10:00')) }, { id: 'exit', occurredAt: new Date(instant('17:30')) }], changed, policy, zone);
    applyLeaveAuthorizations(day, [arrival], changed, policy, zone);
    expect(day.incidents[0].minutes).toBe(60);
  });
  it('keeps later unapproved work hours uncovered when the schedule end changes', () => {
    const departure = { ...arrival, kind: 'early_exit' as const, authorizedTime: '16:00', start: instant('16:00'), end: instant('17:30') };
    expect(unauthorizedEarlyExit(date, instant('16:00'), { ...schedule, exitTime: '18:30' }, [departure], zone)).toBe(60);
  });
  it('recognizes departure before a configured meal without requiring meal punches or creating worked hours', () => {
    const departure = { ...arrival, kind: 'early_exit' as const, authorizedTime: '12:00', start: instant('12:00'), end: instant('17:30') };
    const adjusted = authorizedSchedule(schedule, [departure]);
    const logs = ['08:30','12:00'].map((time) => ({ id: time, occurredAt: new Date(instant(time)) }));
    const day = evaluateDay(date, logs, adjusted, policy, zone);
    expect(day.status).toBe('complete'); expect(day.workedMinutes).toBe(210); expect(day.missingMovements).toEqual([]);
    const empty = evaluateDay(date, [], adjusted, policy, zone);
    applyLeaveAuthorizations(empty, [departure], schedule, policy, zone);
    expect(empty.workedMinutes).toBeUndefined(); expect(empty.status).not.toBe('authorized_absence');
  });
});
