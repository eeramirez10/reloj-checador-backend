import type { LeaveAuthorization, LeaveRequest } from './leave.js';
import type { PolicySettings, ScheduleSettings } from './organization.js';
import type { DailyEvaluation } from './schedule-evaluator.js';
import { dateAtLocalTime } from './local-date.js';
import { pendingOvertime } from './overtime.js';
import { latenessMinutes } from './tolerance.js';

export function authorizationsForDay(requests: LeaveRequest[], date: string): LeaveAuthorization[] {
  return requests.filter((request) => request.status === 'approved').flatMap((request) => request.details.days
    .filter((day) => day.date === date).map((day) => ({ requestId: request.id, kind: request.kind, paid: request.paid,
      useVacation: request.useVacation, reason: request.reason, authorizedTime: request.authorizedTime, start: day.start, end: day.end })));
}

export function authorizedSchedule(schedule: ScheduleSettings, authorizations: LeaveAuthorization[]): ScheduleSettings {
  const permittedEntry = authorizations.find((item) => item.kind === 'late_arrival')?.authorizedTime;
  const permittedExit = authorizations.find((item) => item.kind === 'early_exit')?.authorizedTime;
  const entryTime = permittedEntry && permittedEntry > schedule.entryTime ? permittedEntry : schedule.entryTime;
  const exitTime = permittedExit && permittedExit < schedule.exitTime ? permittedExit : schedule.exitTime;
  if (entryTime >= exitTime) return schedule;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const skipsMeal = schedule.mealEnabled && (exitTime <= schedule.mealStart || minutes(entryTime) >= minutes(schedule.mealEnd) + schedule.mealDurationMinutes);
  return { ...schedule, entryTime, exitTime, ...(skipsMeal ? { mealEnabled: false, mealDetection: 'disabled' as const } : {}) };
}

export function applyLeaveAuthorizations(day: DailyEvaluation, authorizations: LeaveAuthorization[], schedule: ScheduleSettings | undefined,
  policy: PolicySettings | undefined, timeZone: string): void {
  if (!authorizations.length) return;
  day.leaveAuthorizations = authorizations;
  if (authorizations.some((item) => item.kind === 'absence')) {
    day.incidents = [];
    if (!day.punches.length && !day.routes?.length) {
      day.status = 'authorized_absence'; day.issues = []; day.missingMovements = [];
      if (day.overtime) day.overtime = pendingOvertime('no_records', 'Ausencia autorizada sin checadas; no hay horas extras registradas.');
    }
    return;
  }
  const arrival = authorizations.find((item) => item.kind === 'late_arrival');
  if (arrival && schedule) {
    day.incidents = day.incidents.filter((incident) => incident.kind !== 'arrival');
    const entryLog = day.punches.find((punch) => punch.movement === 'entry');
    const weekday = new Date(`${day.date}T12:00:00Z`).getUTCDay() || 7;
    const continuingRoute = day.routes?.some((route) => Date.parse(route.segmentStart) <= Date.parse(arrival.end)
      && (!route.segmentEnd || Date.parse(route.segmentEnd) > Date.parse(arrival.end)));
    if (entryLog && policy && !continuingRoute && schedule.workDays.includes(weekday)) {
      const expected = dateAtLocalTime(day.date, schedule.entryTime, timeZone).getTime();
      const actual = Date.parse(entryLog.occurredAt);
      const covered = Math.max(0, Math.min(actual, Date.parse(arrival.end)) - Math.max(expected, Date.parse(arrival.start)));
      const minutes = latenessMinutes(actual, expected + covered);
      if (minutes > policy.entryToleranceMinutes) day.incidents.push({ kind: 'arrival', logId: entryLog.id,
        occurredAt: entryLog.occurredAt, minutes });
    }
  }
}

export function unauthorizedEarlyExit(date: string, exit: string | null, schedule: ScheduleSettings | null,
  authorizations: LeaveAuthorization[], timeZone: string): number | null {
  if (!exit || !schedule) return null;
  if (authorizations.some((item) => item.kind === 'absence')) return 0;
  const permitted = authorizations.find((item) => item.kind === 'early_exit');
  const expected = dateAtLocalTime(date, schedule.exitTime, timeZone).getTime();
  const actual = Date.parse(exit);
  const covered = permitted ? Math.max(0, Math.min(expected, Date.parse(permitted.end)) - Math.max(actual, Date.parse(permitted.start))) : 0;
  return Math.max(0, Math.ceil((expected - actual - covered) / 60_000));
}
