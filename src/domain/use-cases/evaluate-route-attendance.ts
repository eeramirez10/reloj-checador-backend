import { formatDateTimeInTimeZone } from '../entities/attendance-summary.js';
import { addDays, dateAtLocalTime } from '../entities/local-date.js';
import { allocateAdditionalRest, calculateOvertime, pendingOvertime, restIntervals, type OvertimeDay, type RouteDaySegment } from '../entities/overtime.js';
import { DEFAULT_ENTRY_REPEAT_WINDOW_MINUTES } from '../entities/organization.js';
import type { ClassifiedPunch, DailyEvaluation } from '../entities/schedule-evaluator.js';
import { intervalSeconds, subtractIntervals, type TimeInterval } from '../entities/time-interval.js';
import type { SubjectLog } from '../repositories/evaluation-repository.js';
import { additionalRestSeconds, combineOvertimeDays } from './attendance-overtime.js';
import { SubjectAttendanceContext, type AttendanceContext, type EvaluatedAttendanceDay } from './attendance-context.js';
import { latenessMinutes } from '../entities/tolerance.js';

export interface RouteJourney {
  entry: SubjectLog; exit?: SubjectLog; duplicates: SubjectLog[]; context: AttendanceContext;
}
interface RoutePart { journey: RouteJourney; route: RouteDaySegment; interval: TimeInterval | null; overtime?: OvertimeDay; workedSeconds: number }
interface RouteDay { context: AttendanceContext; parts: RoutePart[]; logs: SubjectLog[]; punches: ClassifiedPunch[] }

export function routeRepeatWindow(context: AttendanceContext): number {
  return (context.policy?.settings.entryRepeatWindowMinutes ?? DEFAULT_ENTRY_REPEAT_WINDOW_MINUTES) * 60_000;
}

function splitJourney(journey: RouteJourney, resolver: SubjectAttendanceContext, now: Date): Array<{ context: AttendanceContext; part: RoutePart }> {
  const zone = journey.context.branch?.timeZone ?? 'America/Mexico_City';
  const first = formatDateTimeInTimeZone(journey.entry.occurredAt,zone).slice(0,10);
  const lastInstant = journey.duplicates.reduce((latest,log) => log.occurredAt > latest ? log.occurredAt : latest,journey.exit?.occurredAt ?? now);
  const last = resolver.latestLocalDate(lastInstant);
  const result: Array<{ context: AttendanceContext; part: RoutePart }> = [];
  for (let date = first; date <= last; date = addDays(date,1)) {
    const context = resolver.at(date,resolver.branchAt(date,journey.context.branch),true);
    const dayZone = context.branch?.timeZone ?? 'America/Mexico_City';
    const nextZone = resolver.branchAt(addDays(date,1),journey.context.branch)?.timeZone ?? 'America/Mexico_City';
    const midnight = dateAtLocalTime(date,'00:00',dayZone).getTime();
    if (midnight > lastInstant.getTime()) break;
    const start = Math.max(journey.entry.occurredAt.getTime(),midnight);
    const end = journey.exit ? Math.max(start,Math.min(journey.exit.occurredAt.getTime(),dateAtLocalTime(addDays(date,1),'00:00',nextZone).getTime())) : null;
    const interval = end !== null ? { start, end } : null;
    const overtime = !context.overtime.enabled ? undefined : !interval ? pendingOvertime('pending','Ruta pendiente de regreso.')
      : calculateOvertime(date,dayZone,context.base?.settings,[interval],context.overtime,context.policy?.settings);
    const workedSeconds = interval ? intervalSeconds(subtractIntervals([interval],restIntervals(date,dayZone,context.overtime))) : 0;
    result.push({ context, part: { journey, interval, overtime, workedSeconds, route: { id: journey.entry.id, entryLogId: journey.entry.id,
      exitLogId: journey.exit?.id ?? null, enteredAt: journey.entry.occurredAt.toISOString(), exitedAt: journey.exit?.occurredAt.toISOString() ?? null,
      segmentStart: new Date(start).toISOString(), segmentEnd: end !== null ? new Date(end).toISOString() : null, timeZone: dayZone } } });
    if (date === last) break;
  }
  const eligible = result.filter((item) => item.part.overtime);
  if (eligible.some((item) => item.part.overtime!.status !== 'calculated')) {
    for (const item of eligible) item.part.overtime = pendingOvertime('pending',journey.exit ? 'Falta una jornada aplicable para completar el cálculo de la ruta.' : 'Ruta pendiente de regreso.');
  } else {
    const allocations = allocateAdditionalRest(eligible.map((item) => item.part.overtime!.netSeconds!),additionalRestSeconds(journey.context.overtime));
    for (const [index,item] of eligible.entries()) {
      item.part.overtime!.additionalRestSeconds = allocations[index];
      item.part.overtime!.netSeconds! -= allocations[index];
      item.part.workedSeconds -= allocations[index];
    }
  }
  for (const item of result) if (journey.exit) item.part.route.workedSeconds = item.part.workedSeconds;
  return result;
}

function combineOvertime(parts: RoutePart[]): OvertimeDay | undefined {
  const values = parts.map((item) => item.overtime).filter((item): item is OvertimeDay => Boolean(item));
  return combineOvertimeDays(values);
}

function finishDay(day: RouteDay): EvaluatedAttendanceDay {
  const { context, parts } = day;
  const zone = context.branch?.timeZone ?? 'America/Mexico_City';
  const pending = parts.some((item) => !item.journey.exit);
  const weekday = new Date(`${context.date}T12:00:00Z`).getUTCDay() || 7;
  const dayOff = context.base ? !context.base.settings.workDays.includes(weekday) : false;
  const punches = [...day.punches].sort((a,b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  const entry = punches.find((item) => item.movement === 'entry');
  const exit = punches.filter((item) => item.movement === 'exit').at(-1);
  const daily: DailyEvaluation = { date: context.date, status: !context.base ? 'unconfigured' : pending ? 'in_progress' : dayOff ? 'day_off' : 'complete',
    entry: entry?.occurredAt, exit: exit?.occurredAt, punches, routes: parts.map((item) => item.route),
    workedMinutes: pending ? undefined : Math.round(parts.reduce((sum,item) => sum + item.workedSeconds,0) / 60),
    overtime: combineOvertime(parts), issues: pending ? ['Ruta pendiente de regreso.'] : !context.base ? ['Falta una jornada de sucursal vigente.'] : [], incidents: [], missingMovements: [] };
  if (entry && context.base && context.policy && !dayOff) {
    const expected = dateAtLocalTime(context.date,context.base.settings.entryTime,zone).getTime();
    const alreadyWorking = parts.some((item) => item.interval ? item.interval.start <= expected && item.interval.end > expected : Date.parse(item.route.segmentStart) <= expected);
    const minutes = latenessMinutes(Date.parse(entry.occurredAt), expected);
    if (!alreadyWorking && minutes > context.policy.settings.entryToleranceMinutes) daily.incidents.push(
      { kind: 'arrival', logId: entry.id, occurredAt: entry.occurredAt, minutes });
  }
  return { ...context, subject: parts[0].journey.entry, logs: day.logs, daily };
}

export function evaluateRoutes(journeys: RouteJourney[], resolver: SubjectAttendanceContext, now: Date): EvaluatedAttendanceDay[] {
  const days = new Map<string, RouteDay>();
  for (const journey of journeys) {
    for (const { context,part } of splitJourney(journey,resolver,now)) {
      const key = context.date;
      const day = days.get(key) ?? { context, parts: [], logs: [], punches: [] };
      day.parts.push(part);
      const sources = [{ log: journey.entry, movement: 'entry' as const }, ...(journey.exit ? [{ log: journey.exit, movement: 'exit' as const }] : []),
        ...journey.duplicates.map((log) => ({ log, movement: 'duplicate' as const }))];
      for (const { log,movement } of sources) {
        const located = resolver.locate(log);
        const localTime = formatDateTimeInTimeZone(log.occurredAt,located.branch?.timeZone ?? 'America/Mexico_City');
        if (located.date !== context.date || day.punches.some((item) => item.id === log.id)) continue;
        day.logs.push(log);
        day.punches.push({ id: log.id, occurredAt: log.occurredAt.toISOString(), localTime, movement });
      }
      days.set(key,day);
    }
  }
  return [...days.values()].map(finishDay);
}
