import { z } from 'zod';
import { dateSchema } from './organization.js';

export const leaveInputSchema = z.object({
  employeeId: z.string().uuid(), kind: z.enum(['absence', 'late_arrival', 'early_exit']),
  from: dateSchema, to: dateSchema, authorizedTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  paid: z.boolean(), useVacation: z.boolean(), reason: z.string().trim().min(1).max(2000),
}).strict().superRefine((input, context) => {
  if (input.from > input.to || Date.parse(input.to) - Date.parse(input.from) >= 366 * 86400000) context.addIssue({ code: 'custom', message: 'Selecciona un rango válido de hasta 366 días.', path: ['to'] });
  if ((input.kind === 'absence') !== (input.authorizedTime === null)) context.addIssue({ code: 'custom', message: 'Indica una hora autorizada solo para llegada tarde o salida temprana.', path: ['authorizedTime'] });
  if (input.useVacation && (input.kind !== 'absence' || !input.paid)) context.addIssue({ code: 'custom', message: 'Las vacaciones corresponden a permisos para faltar con goce de sueldo.', path: ['useVacation'] });
});
export const leaveCreateSchema = z.object({ input: leaveInputSchema, previewToken: z.string().regex(/^[a-f0-9]{64}$/), sourceKey: z.string().uuid() }).strict();
export const leaveProfileSchema = z.object({
  managerId: z.string().uuid().nullable(), whatsappPhone: z.string().trim().min(1).max(40).nullable(),
  vacationBalance: z.number().int().min(0).max(10000), expectedVersion: z.number().int().min(0), adjustmentReason: z.string().trim().max(2000),
}).strict();
export const leaveResolutionSchema = z.object({
  action: z.enum(['approve', 'reject', 'cancel']), expectedVersion: z.number().int().min(1),
  actorEmployeeId: z.string().uuid(), comments: z.string().trim().max(2000).default(''),
}).strict();
export const leaveFiltersSchema = z.object({
  from: dateSchema, to: dateSchema, branchId: z.string().uuid().optional(), employeeId: z.string().uuid().optional(), managerId: z.string().uuid().optional(),
  status: z.enum(['pending','approved','rejected','cancelled']).optional(), kind: z.enum(['absence','late_arrival','early_exit']).optional(),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict().refine((value) => value.from <= value.to, 'El rango de fechas es inválido.');
