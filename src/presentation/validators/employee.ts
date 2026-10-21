import { z } from 'zod';
import { personalProfileSchema, socialSecurityNumberSchema } from './personal-profile.js';

const nullableText = z.string().trim().max(200).nullable().optional();
export const employeeEditSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(), employeeNumber: z.string().regex(/^\d{8}$/).nullable().optional(),
  position: nullableText, imss: socialSecurityNumberSchema, isActive: z.boolean().optional(),
}).extend(personalProfileSchema.shape).strict();
export const employeeCreateSchema = personalProfileSchema.extend({
  firstName: z.string().trim().min(1).max(150), branchId: z.string().uuid(), position: nullableText,
}).strict();
export const employeeIdentifySchema = personalProfileSchema.extend({
  targetEmployeeId: z.string().uuid().optional(), useAsAssignedClock: z.boolean().default(false),
}).strict();
export const employeeClockSchema = z.object({ clockRecordId: z.string().uuid() });
export const employeeListSchema = z.object({
  search: z.string().trim().max(120).optional(), branchCode: z.string().trim().max(20).optional(),
  employmentStatus: z.enum(['active', 'inactive', 'pending']).optional(),
  identificationStatus: z.enum(['confirmed', 'pending']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});
