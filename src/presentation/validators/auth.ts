import { z } from 'zod';
export const passwordSchema = z.string().min(8, 'Usa al menos 8 caracteres.').max(128);
export const loginSchema = z.object({ username: z.string().trim().min(1).max(64).transform(value => value.toLowerCase()), password: z.string().min(1).max(128) }).strict();
export const accountSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/,'Usa de 3 a 64 letras, números, puntos, guiones o guiones bajos.'),
  name: z.string().trim().min(1).max(120), role: z.enum(['admin','hr','manager','employee']),
  employeeId: z.string().uuid().nullable().optional(),
  branchIds: z.array(z.string().uuid()).max(100).refine(ids => new Set(ids).size === ids.length, 'No repitas sucursales.'),
  isActive: z.boolean(), password: passwordSchema.optional(),
});
