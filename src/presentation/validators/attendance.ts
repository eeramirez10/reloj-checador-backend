import { z } from 'zod';
import { dateSchema, timeZoneSchema } from './organization.js';

export const attendanceQuerySchema = z.object({
  deviceId: z.string().uuid().optional(), branchId: z.string().uuid().optional(), userId: z.string().min(1).optional(),
  from: z.coerce.date().optional(), to: z.coerce.date().optional(), timeZone: timeZoneSchema.default('America/Mexico_City'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const summaryQuerySchema = attendanceQuerySchema.pick({ deviceId: true, from: true, to: true, timeZone: true })
  .extend({ deviceId: z.string().uuid() });
export const userParams = z.object({ userId: z.string().min(1) });
export const reportSchema = z.object({
  from: dateSchema, to: dateSchema, branchId: z.string().uuid().optional(), subjectId: z.string().uuid().optional(),
}).refine((value) => value.to >= value.from && (Date.parse(value.to) - Date.parse(value.from)) / 86400000 <= 366,
  'El rango debe ser de hasta 366 días.');
