import { z } from 'zod';
import { dateSchema, timeSchema } from './organization.js';

export const workHoursSchema = z.object({
  workDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine((days) => new Set(days).size === days.length),
  entryTime: timeSchema, exitTime: timeSchema,
}).strict();
export const mealSettingsSchema = z.object({
  enabled: z.boolean(), startTime: timeSchema, endTime: timeSchema,
  durationMinutes: z.number().int().min(1).max(240),
}).strict();
export const employeeSchedulingSchema = z.object({
  effectiveFrom: dateSchema, workHours: workHoursSchema.nullable(), meal: mealSettingsSchema.nullable(),
  recognitionMarginMinutes: z.number().int().min(0).max(120).default(30),
  expectedVersionId: z.string().uuid().nullable().optional(),
}).strict();
