import { z } from 'zod';
import { dateSchema } from './organization.js';
import { companyFilterSchema } from './company.js';

const periodFields = { from: dateSchema, to: dateSchema };
const validPeriod = ({ from, to }: { from: string; to: string }) => from <= to && (Date.parse(to) - Date.parse(from)) / 86_400_000 < 366;
const periodMessage = 'Selecciona un periodo válido de hasta 366 días.';

export const employeeAttendanceQuerySchema = z.object(periodFields).refine(validPeriod, periodMessage);
const branchFields = { ...periodFields, branchId: z.string().uuid(), employeeStatus: z.enum(['active','inactive']),companyId: companyFilterSchema };
export const branchAttendanceQuerySchema = z.object({ ...branchFields,
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(10).default(5),
}).refine(validPeriod, periodMessage);
export const branchAttendanceExportSchema = z.object(branchFields).strict().refine(validPeriod, periodMessage);
