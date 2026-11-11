import { z } from 'zod';
import { dateSchema } from './organization.js';

export const leaveInputSchema = z.object({
  employeeId: z.string().uuid(), kind: z.enum(['absence', 'late_arrival', 'early_exit','home_office','client_visit']),
  from: dateSchema, to: dateSchema, authorizedTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().default(null),
  clientName:z.string().trim().min(1).max(200).nullable().default(null),fullDay:z.boolean().default(true),replacesRequestId:z.string().uuid().nullable().default(null),
  paid: z.boolean(), useVacation: z.boolean(), reason: z.string().trim().min(1).max(2000),
}).strict().superRefine((input, context) => {
  if (input.from > input.to || Date.parse(input.to) - Date.parse(input.from) >= 366 * 86400000) context.addIssue({ code: 'custom', message: 'Selecciona un rango válido de hasta 366 días.', path: ['to'] });
  if (!['late_arrival','early_exit'].includes(input.kind) && input.authorizedTime!==null) context.addIssue({code:'custom',message:'Este tipo de permiso no utiliza horario.',path:['authorizedTime']});
  if (input.kind!=='client_visit' && input.clientName!==null) context.addIssue({code:'custom',message:'El nombre del cliente corresponde a una visita a cliente.',path:['clientName']});
  if (input.kind!=='client_visit' && !input.fullDay) context.addIssue({code:'custom',message:'La modalidad abierta corresponde a visitas a cliente.',path:['fullDay']});
  if (['home_office','client_visit'].includes(input.kind) && (!input.paid || input.useVacation)) context.addIssue({code:'custom',message:'El trabajo autorizado no consume vacaciones y es con goce de sueldo.',path:['useVacation']});
  if (input.useVacation && (input.kind !== 'absence' || !input.paid)) context.addIssue({ code: 'custom', message: 'Las vacaciones corresponden a permisos para faltar con goce de sueldo.', path: ['useVacation'] });
});
export const leaveCreateSchema = z.object({ input: leaveInputSchema, previewToken: z.string().regex(/^[a-f0-9]{64}$/), sourceKey: z.string().uuid() }).strict();
export const leaveProfileSchema = z.object({
  managerId: z.string().uuid().nullable(), whatsappPhone: z.string().trim().min(1).max(40).nullable(),
  vacationBalance: z.number().int().min(0).max(10000), expectedVersion: z.number().int().min(0), adjustmentReason: z.string().trim().max(2000),
}).strict();
export const leaveResolutionSchema = z.object({
  action: z.enum(['approve', 'reject', 'cancel']), expectedVersion: z.number().int().min(1),
  comments: z.string().trim().max(2000).default(''),
}).strict();
export const leaveFiltersSchema = z.object({
  from: dateSchema, to: dateSchema, branchId: z.string().uuid().optional(), employeeId: z.string().uuid().optional(), managerId: z.string().uuid().optional(),
  status: z.enum(['pending','approved','rejected','cancelled']).optional(), kind: z.enum(['absence','late_arrival','early_exit','home_office','client_visit']).optional(),
  scope: z.enum(['own','assigned']).optional(),
  page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict().refine((value) => value.from <= value.to, 'El rango de fechas es inválido.');
