import { z } from 'zod';
import { DEFAULT_ENTRY_REPEAT_WINDOW_MINUTES } from '../../domain/entities/organization.js';

export { ConfigurationError } from '../../domain/errors/app-error.js';
export type { BranchInput, Branch, PolicySettings, BranchPolicy, ScheduleSettings, WorkSchedule, AssignmentTargets } from '../../domain/entities/organization.js';

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, 'Fecha inválida.');
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const timeZoneSchema = z.string().refine((value) => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
}, 'Zona horaria inválida.');

export const branchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  street: z.string().trim().max(200).default(''),
  exteriorNumber: z.string().trim().max(30).default(''),
  interiorNumber: z.string().trim().max(30).default(''),
  neighborhood: z.string().trim().max(120).default(''),
  postalCode: z.string().trim().max(20).default(''),
  city: z.string().trim().max(120).default(''),
  state: z.string().trim().max(120).default(''),
  country: z.string().trim().max(120).default('México'),
  phone: z.string().trim().max(40).default(''),
  email: z.union([z.literal(''), z.string().email()]).default(''),
  managerName: z.string().trim().max(120).default(''),
  timeZone: timeZoneSchema.default('America/Mexico_City'),
  active: z.boolean().default(true),
  notes: z.string().trim().max(2000).default(''),
});

export const policySettingsSchema = z.object({
  overtimeEntryMarginMinutes: z.number().int().min(0).max(240).optional(),
  overtimeExitMarginMinutes: z.number().int().min(0).max(240).optional(),
  entryRepeatWindowMinutes: z.number().int().min(0).max(120).default(DEFAULT_ENTRY_REPEAT_WINDOW_MINUTES),
  entryToleranceMinutes: z.number().int().min(0).max(120),
  mealToleranceMinutes: z.number().int().min(0).max(120),
  entryAllowedTardies: z.number().int().min(0).max(100),
  mealAllowedTardies: z.number().int().min(0).max(100),
  accumulationMode: z.enum(['first_lateness', 'calendar_month']),
  accumulationDays: z.number().int().min(1).max(366).default(30),
});
export const policySchema = z.object({ effectiveFrom: dateSchema, settings: policySettingsSchema });

export const scheduleSettingsSchema = z.object({
  workDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine((days) => new Set(days).size === days.length),
  entryTime: timeSchema,
  exitTime: timeSchema,
  mealEnabled: z.boolean().default(false),
  mealStart: timeSchema.default('00:00'),
  mealEnd: timeSchema.default('00:00'),
  mealDurationMinutes: z.number().int().min(1).max(240).default(60),
  mealMode: z.enum(['schedule', 'individual']).optional(),
  recognitionMarginMinutes: z.number().int().min(0).max(120).optional(),
}).superRefine((value, context) => {
  if (value.entryTime >= value.exitTime) context.addIssue({ code: 'custom', message: 'La salida debe ser posterior a la entrada en el mismo día.' });
  if (value.mealEnabled && (value.mealStart <= value.entryTime || value.mealEnd < value.mealStart || value.mealEnd >= value.exitTime)) {
    context.addIssue({ code: 'custom', message: 'El rango de comida debe estar dentro de la jornada.' });
  }
});
export const scheduleSchema = z.object({
  branchId: z.string().uuid(), name: z.string().trim().min(1).max(120),
  effectiveFrom: dateSchema, isDefault: z.boolean(), settings: scheduleSettingsSchema,
});
export const targetSchema = z.object({
  employeeIds: z.array(z.string().uuid()).max(500).default([]),
  deviceUserIds: z.array(z.string().uuid()).max(500).default([]),
  effectiveFrom: dateSchema,
}).refine((value) => value.employeeIds.length + value.deviceUserIds.length > 0, 'Selecciona al menos una persona.');

export const branchTargetsSchema = z.object({
  employeeIds: z.array(z.string().uuid()).max(500).default([]), deviceUserIds: z.array(z.string().uuid()).max(500).default([]),
  deviceIds: z.array(z.string().uuid()).max(500).default([]), effectiveFrom: dateSchema,
}).refine((value) => value.employeeIds.length + value.deviceUserIds.length + value.deviceIds.length > 0);

export const assignmentSchema = z.object({
  employeeIds: z.array(z.string().uuid()).max(500).default([]), deviceUserIds: z.array(z.string().uuid()).max(500).default([]),
  deviceIds: z.array(z.string().uuid()).max(500).default([]), effectiveFrom: dateSchema,
  branchId: z.string().uuid().optional(), scheduleId: z.string().uuid().nullable().optional(),
}).refine((value) => value.employeeIds.length + value.deviceUserIds.length + value.deviceIds.length > 0
    && (Boolean(value.branchId) || value.scheduleId !== undefined), 'Selecciona personas y una asignación.')
  .refine((value) => value.deviceIds.length === 0 || (value.employeeIds.length === 0 && value.deviceUserIds.length === 0 && value.scheduleId === undefined),
    'Los relojes solo reciben asignaciones de sucursal.');
