import { formatDateTimeInTimeZone } from './attendance-summary.js';
import { DEFAULT_ENTRY_REPEAT_WINDOW_MINUTES, type PolicySettings, type ScheduleSettings } from './organization.js';
import type { OvertimeDay, RouteDaySegment } from './overtime.js';
import { addDays, dateAtLocalTime } from './local-date.js';
import type { LeaveAuthorization } from './leave.js';
import { latenessMinutes, toleranceDeadline } from './tolerance.js';
export { addDays, dateAtLocalTime } from './local-date.js';

export type Movement = 'entry' | 'meal_departure' | 'meal_return' | 'exit' | 'unclassified' | 'duplicate' | 'outside_schedule';
export type IncidentKind = 'arrival' | 'meal_departure' | 'meal_return';
export interface EvaluationPunch { id: string; occurredAt: Date }
export interface ClassifiedPunch { id: string; occurredAt: string; localTime: string; movement: Movement }
export interface DailyEvaluation {
  date: string;
  status: 'complete' | 'incomplete' | 'in_progress' | 'ambiguous' | 'day_off' | 'unconfigured' | 'authorized_absence' | 'authorized_work';
  leaveAuthorizations?: LeaveAuthorization[];
  punches: ClassifiedPunch[];
  entry?: string;
  mealDeparture?: string;
  mealReturn?: string;
  expectedMealReturn?: string;
  exit?: string;
  mealMinutes?: number;
  workedMinutes?: number;
  overtime?: OvertimeDay;
  routes?: RouteDaySegment[];
  issues: string[];
  incidents: Array<{ kind: IncidentKind; logId: string; occurredAt: string; minutes: number }>;
  missingMovements?: Array<'entry' | 'meal_departure' | 'meal_return' | 'exit'>;
}

type DayState = 'awaiting_entry' | 'working' | 'on_meal' | 'returned' | 'finished';

function preparePunches(logs: EvaluationPunch[], timeZone: string, entryRepeatWindowMinutes: number,
  mealRecognitionStart: number): { punches: ClassifiedPunch[]; unique: EvaluationPunch[] } {
  const ordered = [...logs].sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id));
  const unique: EvaluationPunch[] = [];
  const entryDeadline = (ordered[0]?.occurredAt.getTime() ?? 0) + entryRepeatWindowMinutes * 60_000;
  const punches = ordered.map((log): ClassifiedPunch => {
    const instant = log.occurredAt.getTime();
    const repeatedEntry = unique.length === 1 && instant <= entryDeadline && instant < mealRecognitionStart;
    const repeatedScan = unique.length > 0 && instant - unique.at(-1)!.occurredAt.getTime() < 60_000;
    const duplicate = repeatedEntry || repeatedScan;
    if (!duplicate) unique.push(log);
    return { id: log.id, occurredAt: log.occurredAt.toISOString(), localTime: formatDateTimeInTimeZone(log.occurredAt, timeZone), movement: duplicate ? 'duplicate' : 'unclassified' };
  });
  return { punches, unique };
}

interface AutomaticDayContext { end: number; margin: number; dayOff: boolean; now: Date }

function evaluateAutomaticMeal(result: DailyEvaluation, logs: EvaluationPunch[], context: AutomaticDayContext,
  classify: (log: EvaluationPunch, movement: Movement) => string, recordArrival: (log: EvaluationPunch) => void): DailyEvaluation {
  const first = logs[0];
  const last = logs.at(-1);
  const closed = context.now.getTime() > context.end + context.margin;
  if (first) { result.entry = classify(first, 'entry'); recordArrival(first); }
  if (logs.length === 4) {
    result.mealDeparture = classify(logs[1], 'meal_departure');
    result.mealReturn = classify(logs[2], 'meal_return');
    result.exit = classify(logs[3], 'exit');
    const meal = logs[2].occurredAt.getTime() - logs[1].occurredAt.getTime();
    result.mealMinutes = Math.round(meal / 60_000);
    result.workedMinutes = Math.max(0, Math.round((logs[3].occurredAt.getTime() - first.occurredAt.getTime() - meal) / 60_000));
    result.status = context.dayOff ? 'day_off' : 'complete';
    return result;
  }
  if (logs.length > 1 && last && (closed || last.occurredAt.getTime() >= context.end - context.margin)) {
    result.exit = classify(last, 'exit');
  }
  if (logs.length === 3 && result.exit) result.mealDeparture = classify(logs[1], 'meal_departure');
  const finished = closed || Boolean(result.exit);
  if (finished && !context.dayOff) {
    if (!result.entry) { result.missingMovements!.push('entry'); result.issues.push('Falta la entrada del trabajo.'); }
    if (!result.exit) { result.missingMovements!.push('exit'); result.issues.push('Falta la salida del trabajo.'); }
    if (logs.length <= 2) {
      result.missingMovements!.push('meal_departure', 'meal_return');
      result.issues.push('No hay dos checadas intermedias para identificar salida y regreso de comida.');
    } else if (logs.length === 3) {
      result.missingMovements!.push('meal_return');
      result.issues.push('Regreso de comida no registrado.');
    }
  }
  if (logs.length > 4) result.issues.push('Hay más de cuatro checadas efectivas; revisa las marcas intermedias antes de identificar la comida.');
  result.status = context.dayOff ? 'day_off' : logs.length > 4 ? 'ambiguous'
    : finished ? 'incomplete' : 'in_progress';
  return result;
}

export function evaluateDay(date: string, logs: EvaluationPunch[], schedule: ScheduleSettings,
  policy: PolicySettings | undefined, timeZone: string, now = new Date(), options: { firstPunchIsEntry?: boolean } = {}): DailyEvaluation {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  const dayOff = !schedule.workDays.includes(weekday);
  const start = dateAtLocalTime(date, schedule.entryTime, timeZone).getTime();
  const end = dateAtLocalTime(date, schedule.exitTime, timeZone).getTime();
  const mealStart = schedule.mealEnabled ? dateAtLocalTime(date, schedule.mealStart, timeZone).getTime() : 0;
  const mealEnd = schedule.mealEnabled ? dateAtLocalTime(date, schedule.mealEnd, timeZone).getTime() : 0;
  const margin = (schedule.recognitionMarginMinutes ?? 30) * 60_000;
  const { punches, unique } = preparePunches(logs, timeZone, policy?.entryRepeatWindowMinutes ?? DEFAULT_ENTRY_REPEAT_WINDOW_MINUTES,
    schedule.mealEnabled ? mealStart - margin : Number.POSITIVE_INFINITY);
  const result: DailyEvaluation = { date, status: 'incomplete', punches, issues: [], incidents: [], missingMovements: [] };
  const nearScheduledExit = (value: number) => value >= end - margin && value <= end + margin;
  const workdayElapsed = now.getTime() > end + margin;
  let state: DayState = 'awaiting_entry';
  let ambiguous = false;
  const byId = new Map(punches.map((punch) => [punch.id, punch]));
  const classify = (log: EvaluationPunch, movement: Movement) => {
    byId.get(log.id)!.movement = movement;
    return log.occurredAt.toISOString();
  };
  const recordLate = (log: EvaluationPunch, expected: number, tolerance: number, kind: IncidentKind) => {
    if (!policy || dayOff) return;
    const minutes = latenessMinutes(log.occurredAt.getTime(), expected);
    if (minutes > tolerance) result.incidents.push({ kind, logId: log.id, occurredAt: log.occurredAt.toISOString(), minutes });
  };
  if (schedule.mealDetection === 'automatic') {
    return evaluateAutomaticMeal(result, unique, { end, margin, dayOff, now }, classify,
      (log) => recordLate(log, start, policy?.entryToleranceMinutes ?? 0, 'arrival'));
  }
  for (const [index, log] of unique.entries()) {
    const instant = log.occurredAt.getTime();
    const lastPunch = index === unique.length - 1;
    const nearExit = nearScheduledExit(instant);
    if (lastPunch && index > 0 && (workdayElapsed || nearExit)) {
      result.exit = classify(log, 'exit'); state = 'finished';
      continue;
    }
    const departure = schedule.mealEnabled && (state === 'working' || state === 'awaiting_entry')
      && instant >= mealStart - margin && instant <= mealEnd + margin;
    if (state === 'awaiting_entry' && index === 0 && (options.firstPunchIsEntry || !schedule.mealEnabled || instant < mealStart - margin)) {
      result.entry = classify(log, 'entry'); state = 'working';
      recordLate(log, start, policy?.entryToleranceMinutes ?? 0, 'arrival');
      continue;
    }
    if (departure && !(lastPunch && nearExit)) {
      result.mealDeparture = classify(log, 'meal_departure'); state = 'on_meal';
      result.expectedMealReturn = new Date(instant + schedule.mealDurationMinutes * 60_000).toISOString();
      recordLate(log, mealEnd, policy?.mealToleranceMinutes ?? 0, 'meal_departure');
      continue;
    }
    if (state === 'on_meal') {
      const expected = Date.parse(result.expectedMealReturn!);
      const returned = instant >= Date.parse(result.mealDeparture!) + 60_000 && instant <= expected + margin;
      if (returned) {
        result.mealReturn = classify(log, 'meal_return'); state = 'returned';
        result.mealMinutes = Math.round((instant - Date.parse(result.mealDeparture!)) / 60_000);
        recordLate(log, expected, policy?.mealToleranceMinutes ?? 0, 'meal_return');
        continue;
      }
    }
    const exit = lastPunch && index > 0 && (state === 'returned' || state === 'on_meal'
      || (!schedule.mealEnabled && !schedule.mealPending));
    if (exit) {
      result.exit = classify(log, 'exit'); state = 'finished';
      continue;
    }
    if (schedule.mealPending && state === 'working') continue;
    classify(log, 'outside_schedule');
    result.issues.push(`Checada fuera de horario: ${formatDateTimeInTimeZone(log.occurredAt, timeZone)}.`);
    ambiguous = true;
  }
  const closed = Boolean(result.exit) || now.getTime() > end + margin;
  const missing = (movement: 'entry' | 'meal_departure' | 'meal_return' | 'exit', message: string, due: boolean) => {
    if (due && !dayOff) { result.missingMovements!.push(movement); result.issues.push(message); }
  };
  missing('entry', 'Falta la entrada del trabajo.', !result.entry && (closed || now.getTime() > start + margin));
  if (schedule.mealEnabled) {
    missing('meal_departure', 'Falta la salida a comer.', !result.mealDeparture && (closed || now.getTime() > mealEnd + margin));
    const expectedReturn = result.expectedMealReturn ? Date.parse(result.expectedMealReturn) : mealEnd + margin + schedule.mealDurationMinutes * 60_000;
    const returnDeadline = toleranceDeadline(expectedReturn, policy?.mealToleranceMinutes ?? 0);
    missing('meal_return', 'Regreso de comida no registrado.', !result.mealReturn && (closed || now.getTime() >= returnDeadline));
  }
  missing('exit', 'Falta la salida del trabajo.', !result.exit && now.getTime() > end + margin);
  if (schedule.mealPending) result.issues.push('El horario individual de comida ya no cabe en la jornada aplicable; revisa su configuración.');
  if (result.entry && result.exit && !schedule.mealPending && (!schedule.mealEnabled || (result.mealDeparture && result.mealReturn))) {
    const meal = result.mealDeparture && result.mealReturn ? Date.parse(result.mealReturn) - Date.parse(result.mealDeparture) : 0;
    result.workedMinutes = Math.max(0, Math.round((Date.parse(result.exit) - Date.parse(result.entry) - meal) / 60_000));
  }
  const complete = Boolean(result.entry && result.exit && (!schedule.mealEnabled || (result.mealDeparture && result.mealReturn)));
  result.status = dayOff ? 'day_off' : schedule.mealPending ? 'unconfigured' : ambiguous || !result.entry ? 'ambiguous'
    : complete ? 'complete' : closed ? 'incomplete' : 'in_progress';
  return result;
}

export interface CountedIncident {
  id: string;
  policyId: string;
  kind: IncidentKind;
  occurredAt: string;
  date: string;
  settings: PolicySettings;
}
export interface CalculatedDeduction {
  policyId: string;
  category: 'arrival' | 'meal';
  triggerIncidentId: string;
  windowStart: string;
  windowEnd: string;
  incidentIds: string[];
}

export function accumulateIncidents(incidents: CountedIncident[], asOfDate: string) {
  const groups = new Map<string, { start: string; end: string; ids: string[]; category: 'arrival' | 'meal' }>();
  const deductions: CalculatedDeduction[] = [];
  const ordered = [...incidents].filter((incident) => incident.date <= asOfDate)
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  for (const incident of ordered) {
    const category = incident.kind === 'arrival' ? 'arrival' : 'meal';
    const key = category;
    let group = groups.get(key);
    if (!group || incident.date >= group.end) {
      const start = incident.settings.accumulationMode === 'calendar_month' ? `${incident.date.slice(0, 7)}-01` : incident.date;
      const end = incident.settings.accumulationMode === 'calendar_month'
        ? new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 1)).toISOString().slice(0, 10)
        : addDays(start, incident.settings.accumulationDays);
      group = { start, end, ids: [], category };
      groups.set(key, group);
    }
    group.ids.push(incident.id);
    const allowed = category === 'arrival' ? incident.settings.entryAllowedTardies : incident.settings.mealAllowedTardies;
    if (group.ids.length > allowed) {
      deductions.push({ policyId: incident.policyId, category, triggerIncidentId: incident.id,
        windowStart: group.start, windowEnd: group.end, incidentIds: [...group.ids] });
      groups.delete(key);
    }
  }
  const remaining = { arrival: 0, meal: 0 };
  for (const group of groups.values()) if (asOfDate < group.end) remaining[group.category] += group.ids.length;
  return { deductions, remaining };
}
