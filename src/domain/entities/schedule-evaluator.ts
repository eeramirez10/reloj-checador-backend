import { formatDateTimeInTimeZone } from './attendance-summary.js';
import type { PolicySettings, ScheduleSettings } from './organization.js';

export type Movement = 'entry' | 'meal_departure' | 'meal_return' | 'exit' | 'unclassified' | 'duplicate';
export type IncidentKind = 'arrival' | 'meal_departure' | 'meal_return';
export interface EvaluationPunch { id: string; occurredAt: Date }
export interface ClassifiedPunch { id: string; occurredAt: string; localTime: string; movement: Movement }
export interface DailyEvaluation {
  date: string;
  status: 'complete' | 'incomplete' | 'in_progress' | 'ambiguous' | 'day_off' | 'unconfigured';
  punches: ClassifiedPunch[];
  entry?: string;
  mealDeparture?: string;
  mealReturn?: string;
  expectedMealReturn?: string;
  exit?: string;
  mealMinutes?: number;
  workedMinutes?: number;
  issues: string[];
  incidents: Array<{ kind: IncidentKind; logId: string; occurredAt: string; minutes: number }>;
}

export function addDays(date: string, count: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

export function dateAtLocalTime(date: string, time: string, timeZone: string): Date {
  const target = `${date}T${time}:00`;
  const wallTime = Date.parse(`${target}Z`);
  let instant = wallTime;
  for (let index = 0; index < 4; index += 1) {
    const local = formatDateTimeInTimeZone(new Date(instant), timeZone).replace(' ', 'T');
    const offset = Date.parse(`${local}Z`) - wallTime;
    if (offset === 0) return new Date(instant);
    instant -= offset;
  }
  throw new Error(`La hora ${target} no existe en ${timeZone}.`);
}

export function evaluateDay(date: string, logs: EvaluationPunch[], schedule: ScheduleSettings,
  policy: PolicySettings, timeZone: string, now = new Date()): DailyEvaluation {
  const result: DailyEvaluation = { date, status: 'incomplete', punches: [], issues: [], incidents: [] };
  const ordered = [...logs].sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id));
  const unique: EvaluationPunch[] = [];
  for (const log of ordered) {
    const duplicate = unique.length > 0 && log.occurredAt.getTime() - unique.at(-1)!.occurredAt.getTime() < 60_000;
    result.punches.push({ id: log.id, occurredAt: log.occurredAt.toISOString(), localTime: formatDateTimeInTimeZone(log.occurredAt, timeZone), movement: duplicate ? 'duplicate' : 'unclassified' });
    if (!duplicate) unique.push(log);
  }
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7;
  if (!schedule.workDays.includes(weekday)) { result.status = 'day_off'; return result; }
  const start = dateAtLocalTime(date, schedule.entryTime, timeZone);
  const end = dateAtLocalTime(date, schedule.exitTime, timeZone);
  const mealStart = dateAtLocalTime(date, schedule.mealStart, timeZone);
  const mealEnd = dateAtLocalTime(date, schedule.mealEnd, timeZone);
  const classify = (log: EvaluationPunch | undefined, movement: Movement) => {
    if (log) result.punches.find((punch) => punch.id === log.id)!.movement = movement;
    return log?.occurredAt.toISOString();
  };
  const recordLate = (log: EvaluationPunch | undefined, expected: Date, tolerance: number, kind: IncidentKind) => {
    if (!log) return;
    const difference = log.occurredAt.getTime() - expected.getTime();
    if (difference > tolerance * 60_000) result.incidents.push({ kind, logId: log.id, occurredAt: log.occurredAt.toISOString(), minutes: Math.ceil(difference / 60_000) });
  };
  const first = unique[0];
  if (!first || first.occurredAt >= (schedule.mealEnabled ? mealStart : end)) {
    result.status = first ? 'ambiguous' : 'incomplete';
    result.issues.push('No se puede identificar la entrada con las checadas disponibles.');
    return result;
  }
  result.entry = classify(first, 'entry');
  recordLate(first, start, policy.entryToleranceMinutes, 'arrival');

  if (!schedule.mealEnabled) {
    if (unique.length === 2) result.exit = classify(unique[1], 'exit');
    else if (unique.length > 2) result.issues.push('Hay movimientos adicionales que requieren identificar su motivo.');
  } else {
    const middle = unique.slice(1);
    const departure = middle[0];
    if (unique.length === 4 && departure.occurredAt >= mealStart) {
      result.mealDeparture = classify(departure, 'meal_departure');
      result.mealReturn = classify(middle[1], 'meal_return');
      result.exit = classify(middle[2], 'exit');
    } else if (unique.length === 2 && departure.occurredAt >= end) {
      result.exit = classify(departure, 'exit');
    } else if (unique.length <= 3 && departure && departure.occurredAt >= mealStart && departure.occurredAt < end) {
      result.mealDeparture = classify(departure, 'meal_departure');
      if (unique.length === 3 && middle[1].occurredAt < end) result.mealReturn = classify(middle[1], 'meal_return');
      else if (unique.length === 3) result.issues.push('La última checada puede ser regreso de comida o salida; falta un movimiento.');
    } else if (unique.length > 1) result.issues.push('Las checadas no permiten distinguir con certeza comida y salida.');

    if (result.mealDeparture) {
      const expected = new Date(Date.parse(result.mealDeparture) + schedule.mealDurationMinutes * 60_000);
      result.expectedMealReturn = expected.toISOString();
      recordLate(departure, mealEnd, policy.mealToleranceMinutes, 'meal_departure');
      if (result.mealReturn) {
        recordLate(middle[1], expected, policy.mealToleranceMinutes, 'meal_return');
        result.mealMinutes = Math.round((Date.parse(result.mealReturn) - Date.parse(result.mealDeparture)) / 60_000);
      }
    }
    if (!result.mealDeparture) result.issues.push('Falta la salida a comer.');
    if (!result.mealReturn) result.issues.push('Falta el regreso de comida.');
  }
  if (!result.exit) result.issues.push('Falta la salida del trabajo.');
  if (result.exit && (!schedule.mealEnabled || result.mealReturn)) {
    const elapsed = Date.parse(result.exit) - Date.parse(result.entry!);
    const meal = result.mealDeparture && result.mealReturn ? Date.parse(result.mealReturn) - Date.parse(result.mealDeparture) : 0;
    result.workedMinutes = Math.max(0, Math.round((elapsed - meal) / 60_000));
  }
  const ambiguous = result.punches.some((punch) => punch.movement === 'unclassified');
  result.status = ambiguous ? 'ambiguous' : result.issues.length === 0 ? 'complete' : now < end ? 'in_progress' : 'incomplete';
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
