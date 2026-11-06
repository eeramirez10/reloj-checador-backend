import { z } from 'zod';
import { validateManualClockTime } from '../../domain/entities/device-clock.js';

export const manualClockTimeSchema = z.object({
  localTime: z.string().superRefine((value, context) => {
    try { validateManualClockTime(value); }
    catch (error) { context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'Fecha y hora inválidas.' }); }
  }),
}).strict();
