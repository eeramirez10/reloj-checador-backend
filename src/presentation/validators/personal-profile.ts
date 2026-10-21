import { z } from 'zod';
export { getUpdatedProfileName, type UserProfilePatch } from '../../domain/entities/personal-profile.js';

const profileText = z.string().trim().max(150).transform((value) => value || null).nullable().optional();
export const rfcSchema = z.string().trim().transform((value) => value.replace(/[\s-]/g, '').toUpperCase())
  .refine((value) => !value || /^[A-ZÑ&]{3,4}\d{6}[A-Z\d]{3}$/.test(value), 'El RFC debe tener 12 o 13 caracteres con formato válido.')
  .transform((value) => value || null).nullable().optional();
export const socialSecurityNumberSchema = z.string().trim()
  .refine((value) => !value || /^\d{11}$/.test(value), 'El NSS debe contener exactamente 11 dígitos.')
  .transform((value) => value || null).nullable().optional();
export const personalProfileSchema = z.object({
  firstName: profileText, lastName: profileText, rfc: rfcSchema, socialSecurityNumber: socialSecurityNumberSchema,
});
export const userProfileSchema = personalProfileSchema.extend({
  displayName: z.string().trim().min(1).max(200).nullable().optional(),
  employeeId: z.string().uuid().nullable().optional(),
}).strict();
