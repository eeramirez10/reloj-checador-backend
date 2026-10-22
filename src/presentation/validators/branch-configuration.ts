import { z } from 'zod';
import { dateSchema, policySettingsSchema, timeSchema } from './organization.js';
import { workHoursSchema } from './employee-scheduling.js';

export const branchConfigurationSchema = z.object({
  effectiveFrom: dateSchema, workHours: workHoursSchema,
  meal: z.object({ mode: z.enum(['automatic','configured','disabled']), startTime: timeSchema, endTime: timeSchema,
    durationMinutes: z.number().int().min(1).max(240) }).strict(),
  recognitionMarginMinutes: z.number().int().min(0).max(120), policy: policySettingsSchema,
  expectedVersionId: z.string().max(160).nullable().optional(),
}).strict().superRefine(({ workHours, meal }, context) => {
  if (workHours.entryTime >= workHours.exitTime) context.addIssue({ code: 'custom', message: 'La salida debe ser posterior a la entrada.' });
  if (meal.mode === 'configured') {
    const minutes = (time: string) => Number(time.slice(0,2)) * 60 + Number(time.slice(3));
    if (meal.startTime <= workHours.entryTime || meal.endTime < meal.startTime || minutes(meal.endTime) + meal.durationMinutes > minutes(workHours.exitTime)) {
      context.addIssue({ code: 'custom', message: 'El rango y la duración de comida deben permitir regresar dentro de la jornada.' });
    }
  }
});
export const configurationVersionParams = z.object({ id: z.string().uuid(), versionId: z.string().uuid() });
export const deleteConfigurationSchema = z.object({ expectedVersionId: z.string().max(160).nullable().optional() }).strict();
