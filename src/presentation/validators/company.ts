import { z } from 'zod';
export const companyFilterSchema = z.union([z.string().uuid(),z.literal('unassigned')]).optional();
export const companySchema = z.object({
  name: z.string().trim().min(1).max(200),code: z.string().trim().min(1).max(50).nullable().default(null),
  active: z.boolean().default(true),notes: z.string().trim().max(2000).default(''),
}).strict();
