import type { PolicySettings, ScheduleSettings } from './organization.js';
import { addDays, dateAtLocalTime } from './local-date.js';
import { intersectIntervals, intervalSeconds, mergeIntervals, subtractIntervals, type TimeInterval } from './time-interval.js';

export interface OvertimeSettings {
  enabled: boolean;
  workMode: 'daily' | 'route';
  restEnabled: boolean;
  dailyRest: { startTime: string; endTime: string } | null;
  additionalRestMinutes: number;
}
export const DEFAULT_OVERTIME_SETTINGS: OvertimeSettings = {
  enabled: false, workMode: 'daily', restEnabled: false, dailyRest: null, additionalRestMinutes: 0,
};
export interface OvertimeDay {
  enabled: true;
  status: 'calculated' | 'pending' | 'no_records';
  beforeSeconds: number | null;
  afterSeconds: number | null;
  dayOffSeconds: number | null;
  grossSeconds: number | null;
  dailyRestSeconds: number | null;
  additionalRestSeconds: number | null;
  netSeconds: number | null;
  referenceEntryTime: string | null;
  referenceExitTime: string | null;
  entryMarginMinutes?: number | null;
  exitMarginMinutes?: number | null;
  issue?: string;
}
export interface RouteDaySegment {
  id: string;
  entryLogId: string;
  exitLogId: string | null;
  enteredAt: string;
  exitedAt: string | null;
  segmentStart: string;
  segmentEnd: string | null;
  timeZone: string;
  workedSeconds?: number;
}

export function pendingOvertime(status: 'pending' | 'no_records', issue: string): OvertimeDay {
  return { enabled: true, status, beforeSeconds: null, afterSeconds: null, dayOffSeconds: null, grossSeconds: null,
    dailyRestSeconds: null, additionalRestSeconds: null, netSeconds: null, referenceEntryTime: null, referenceExitTime: null,
    entryMarginMinutes: null, exitMarginMinutes: null, issue };
}

export function restIntervals(date: string, timeZone: string, settings: OvertimeSettings): TimeInterval[] {
  if (!settings.enabled || !settings.restEnabled || !settings.dailyRest) return [];
  const start = dateAtLocalTime(date,settings.dailyRest.startTime,timeZone).getTime();
  const end = dateAtLocalTime(date,settings.dailyRest.endTime,timeZone).getTime();
  if (end > start) return [{ start, end }];
  return mergeIntervals([{ start: dateAtLocalTime(date,'00:00',timeZone).getTime(), end },
    { start, end: dateAtLocalTime(addDays(date,1),'00:00',timeZone).getTime() }]);
}

export function calculateOvertime(date: string, timeZone: string, schedule: ScheduleSettings | undefined,
  work: TimeInterval[], settings: OvertimeSettings, policy?: PolicySettings): OvertimeDay {
  if (!schedule) return pendingOvertime('pending','Falta una jornada de sucursal vigente.');
  const start = dateAtLocalTime(date,schedule.entryTime,timeZone).getTime();
  const end = dateAtLocalTime(date,schedule.exitTime,timeZone).getTime();
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  const dayOff = !schedule.workDays.includes(weekday);
  const entryMarginMinutes = dayOff ? 0 : policy?.overtimeEntryMarginMinutes ?? 0;
  const exitMarginMinutes = dayOff ? 0 : policy?.overtimeExitMarginMinutes ?? 0;
  const before = dayOff ? [] : intersectIntervals(work,{ start: Number.NEGATIVE_INFINITY, end: start - entryMarginMinutes * 60_000 });
  const after = dayOff ? [] : intersectIntervals(work,{ start: end + exitMarginMinutes * 60_000, end: Number.POSITIVE_INFINITY });
  const extra = dayOff ? mergeIntervals(work) : mergeIntervals([...before,...after]);
  const remaining = subtractIntervals(extra,restIntervals(date,timeZone,settings));
  const gross = intervalSeconds(extra);
  const net = intervalSeconds(remaining);
  return { enabled: true, status: 'calculated', beforeSeconds: intervalSeconds(before), afterSeconds: intervalSeconds(after),
    dayOffSeconds: dayOff ? gross : 0, grossSeconds: gross, dailyRestSeconds: gross - net, additionalRestSeconds: 0, netSeconds: net,
    referenceEntryTime: schedule.entryTime, referenceExitTime: schedule.exitTime, entryMarginMinutes, exitMarginMinutes };
}

export function allocateAdditionalRest(capacities: number[], requestedSeconds: number): number[] {
  const available = capacities.reduce((sum,value) => sum + value,0);
  if (!available) return capacities.map(() => 0);
  const total = Math.min(available,requestedSeconds);
  const exact = capacities.map((value) => value * total / available);
  const allocated = exact.map(Math.floor);
  let remainder = total - allocated.reduce((sum,value) => sum + value,0);
  const order = exact.map((value,index) => ({ index, fraction: value - allocated[index] })).sort((a,b) => b.fraction - a.fraction || a.index - b.index);
  for (const item of order) { if (remainder <= 0) break; allocated[item.index] += 1; remainder -= 1; }
  return allocated;
}
