import { z } from 'zod';
import { timeSchema } from './organization.js';

export const overtimeSettingsSchema = z.object({
  enabled: z.boolean(), workMode: z.enum(['daily','route']), restEnabled: z.boolean(),
  dailyRest: z.object({ startTime: timeSchema, endTime: timeSchema }).strict().nullable(),
  additionalRestMinutes: z.number().int().min(0).max(1_000_000),
}).strict().superRefine((value, context) => {
  if (!value.enabled || !value.restEnabled) return;
  if (!value.dailyRest && !value.additionalRestMinutes) context.addIssue({ code: 'custom', message: 'Configura el horario de descanso, una cantidad adicional o ambos.' });
  if (value.dailyRest?.startTime === value.dailyRest?.endTime && value.dailyRest) context.addIssue({ code: 'custom', message: 'El inicio y fin del descanso deben ser distintos; puede cruzar medianoche.' });
});
