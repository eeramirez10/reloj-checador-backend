import { z } from 'zod';
export const selfContactSchema = z.object({
  whatsappPhone: z.string().trim().min(1).max(40).nullable(),
  alternatePhone: z.string().trim().min(1).max(40).nullable(),
  bloodType: z.string().max(3).nullable(), expectedVersion: z.number().int().min(0),
}).strict();
export const contactSchema = selfContactSchema.extend({ email: z.string().trim().email().max(254).nullable() });
