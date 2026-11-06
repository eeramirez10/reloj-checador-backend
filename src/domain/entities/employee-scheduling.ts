import type { ScheduleSettings, WorkSchedule } from './organization.js';
import { ConfigurationError } from '../errors/app-error.js';
import type { OvertimeSettings } from './overtime.js';

export interface WorkHours { workDays: number[]; entryTime: string; exitTime: string }
export interface MealSettings { enabled: boolean; startTime: string; endTime: string; durationMinutes: number }
export interface EmployeeScheduleSettings {
  workHours: WorkHours | null;
  meal: MealSettings | null;
  mealMode?: 'inherit' | 'automatic' | 'individual';
  recognitionMarginMinutes: number;
  recognitionMarginInherited?: boolean;
  overtime?: OvertimeSettings;
}
export interface EmployeeScheduleInput extends EmployeeScheduleSettings {
  effectiveFrom: string;
  expectedVersionId?: string | null;
}
export interface EmployeeScheduleVersion extends EmployeeScheduleSettings {
  id: string; employeeId: string; effectiveFrom: string; createdAt: Date; source: string;
}
export interface SchedulingContext {
  employeeId: string; date: string; timeZone: string; firstAttendanceDate: string | null;
  baseSchedule?: WorkSchedule; assignedSchedule?: WorkSchedule;
  version?: EmployeeScheduleVersion; latestVersionId: string | null; history: EmployeeScheduleVersion[];
}
export interface ResolvedEmployeeSchedule {
  settings: ScheduleSettings;
  source: 'branch' | 'individual' | 'legacy';
  scheduleId: string | null;
  scheduleName: string;
  versionId: string | null;
}

function timeInMinutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
}

export function effectiveVersion<T extends { effectiveFrom: string; createdAt?: Date; supersededFrom?: string | null; deletedAt?: Date | null }>(items: T[], date: string): T | undefined {
  return items.filter((item) => !item.deletedAt && item.effectiveFrom <= date && (!item.supersededFrom || date < item.supersededFrom))
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom)
      || (right.createdAt?.getTime() ?? 0) - (left.createdAt?.getTime() ?? 0))[0];
}

export function resolveEmployeeSchedule(base: WorkSchedule | undefined, assigned: WorkSchedule | undefined,
  version: EmployeeScheduleVersion | undefined): ResolvedEmployeeSchedule | undefined {
  const origin = version ? base : assigned ?? base;
  const hours = version?.workHours ?? origin?.settings;
  if (!hours) return undefined;
  const mealMode = version?.mealMode ?? (version ? version.meal ? 'individual' : 'automatic' : 'inherit');
  const branchMeal = base?.settings.branchMeal;
  const inheritedMargin = base?.settings.branchMeal ? base.settings.recognitionMarginMinutes : origin?.settings.recognitionMarginMinutes;
  const meal = mealMode === 'individual' ? version?.meal ?? null : mealMode === 'inherit' && branchMeal && branchMeal.mode !== 'automatic'
    ? { enabled: branchMeal.mode === 'configured', startTime: branchMeal.startTime, endTime: branchMeal.endTime, durationMinutes: branchMeal.durationMinutes } : null;
  const mealFits = !meal?.enabled || (meal.startTime > hours.entryTime && meal.endTime >= meal.startTime
    && timeInMinutes(meal.endTime) + meal.durationMinutes <= timeInMinutes(hours.exitTime));
  const mealDetection = !meal ? 'automatic' : !meal.enabled ? 'disabled' : mealFits ? 'configured' : 'invalid';
  return {
    settings: {
      workDays: hours.workDays, entryTime: hours.entryTime, exitTime: hours.exitTime,
      mealEnabled: mealDetection === 'configured', mealStart: meal?.startTime ?? '00:00', mealEnd: meal?.endTime ?? '00:00',
      mealDurationMinutes: meal?.durationMinutes ?? 60, mealPending: mealDetection === 'invalid', mealDetection,
      recognitionMarginMinutes: version && !version.recognitionMarginInherited ? version.recognitionMarginMinutes : inheritedMargin ?? 30,
      mealSource: mealMode === 'inherit' ? 'branch' : mealMode === 'individual' ? 'individual' : 'automatic',
    },
    source: version?.workHours ? 'individual' : !version && assigned ? 'legacy' : 'branch',
    scheduleId: origin?.id ?? null, scheduleName: version?.workHours ? 'Horario individual' : origin?.name ?? 'Horario individual',
    versionId: version?.id ?? null,
  };
}

export function validateEmployeeScheduling(input: EmployeeScheduleInput, base?: WorkSchedule): void {
  if ((input.mealMode === 'inherit' || input.mealMode === 'automatic') && input.meal) throw new ConfigurationError('Selecciona una comida individual o utiliza la configuración heredada.');
  if (input.mealMode === 'individual' && !input.meal) throw new ConfigurationError('Completa la configuración individual de comida.');
  const hours = input.workHours ?? base?.settings;
  if (input.workHours && (input.workHours.entryTime >= input.workHours.exitTime || !input.workHours.workDays.length)) {
    throw new ConfigurationError('La jornada individual debe tener días laborables y una salida posterior a la entrada.');
  }
  if (input.overtime?.enabled && input.overtime.workMode === 'route') return;
  if (input.meal?.enabled) {
    if (!hours) throw new ConfigurationError('Configura la jornada de la sucursal o una jornada individual antes de asignar comida.');
    const meal = input.meal;
    if (meal.startTime <= hours.entryTime || meal.endTime < meal.startTime || meal.endTime >= hours.exitTime) {
      throw new ConfigurationError('El horario de comida debe estar dentro de la jornada aplicable.');
    }
    if (timeInMinutes(meal.endTime) + meal.durationMinutes > timeInMinutes(hours.exitTime)) {
      throw new ConfigurationError('La comida debe permitir regresar antes de finalizar la jornada.');
    }
  }
}
