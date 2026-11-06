import { calculateOvertime, pendingOvertime, restIntervals, type OvertimeDay, type OvertimeSettings } from '../entities/overtime.js';
import { intervalSeconds, subtractIntervals, type TimeInterval } from '../entities/time-interval.js';
import type { DailyEvaluation } from '../entities/schedule-evaluator.js';
import type { AttendanceContext } from './attendance-context.js';

export function dailyOvertimeIntervals(day: DailyEvaluation): TimeInterval[] | null {
  if (!day.entry || !day.exit) return null;
  const start = Date.parse(day.entry);
  const end = Date.parse(day.exit);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const meals = day.mealDeparture && day.mealReturn ? [{ start: Date.parse(day.mealDeparture), end: Date.parse(day.mealReturn) }] : [];
  return subtractIntervals([{ start, end }],meals);
}

export function applyDailyOvertime(day: DailyEvaluation, context: AttendanceContext): void {
  if (!context.overtime.enabled) return;
  if (!context.base) { day.overtime = pendingOvertime('pending','Falta una jornada de sucursal vigente.'); return; }
  const intervals = dailyOvertimeIntervals(day);
  if (!intervals) { day.overtime = pendingOvertime('pending','Falta una entrada o salida laboral válida para calcular las horas extras.'); return; }
  const zone = context.branch?.timeZone ?? 'America/Mexico_City';
  const result = calculateOvertime(day.date,zone,context.base.settings,intervals,context.overtime,context.policy?.settings);
  day.overtime = result;
  if (result.status !== 'calculated') return;
  const additional = additionalRestSeconds(context.overtime);
  result.additionalRestSeconds = Math.min(result.netSeconds!,additional);
  result.netSeconds! -= result.additionalRestSeconds;
  if (day.workedMinutes !== undefined) {
    day.workedMinutes = Math.round((intervalSeconds(subtractIntervals(intervals,restIntervals(day.date,zone,context.overtime))) - result.additionalRestSeconds) / 60);
  }
}

export function additionalRestSeconds(settings: OvertimeSettings): number {
  return settings.enabled && settings.restEnabled ? settings.additionalRestMinutes * 60 : 0;
}

export function combineOvertimeDays(values: OvertimeDay[]): OvertimeDay | undefined {
  if (!values.length) return undefined;
  const pending = values.find((item) => item.status !== 'calculated');
  if (pending) return pendingOvertime('pending',pending.issue ?? 'Hay una jornada pendiente de cálculo.');
  const sum = (key: 'beforeSeconds' | 'afterSeconds' | 'dayOffSeconds' | 'grossSeconds' | 'dailyRestSeconds' | 'additionalRestSeconds' | 'netSeconds') => values.reduce((total,item) => total + item[key]!,0);
  return { ...values[0], beforeSeconds: sum('beforeSeconds'), afterSeconds: sum('afterSeconds'), dayOffSeconds: sum('dayOffSeconds'),
    grossSeconds: sum('grossSeconds'), dailyRestSeconds: sum('dailyRestSeconds'), additionalRestSeconds: sum('additionalRestSeconds'), netSeconds: sum('netSeconds') };
}
