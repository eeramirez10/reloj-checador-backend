import { z } from 'zod';
import { ConfigurationError } from '../organization/schemas.js';

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
export type UserProfilePatch = z.infer<typeof userProfileSchema>;

export function getUpdatedProfileName(current: { firstName: string | null; lastName: string | null },
  changes: { firstName?: string | null; lastName?: string | null }): string | undefined {
  if (changes.firstName === undefined && changes.lastName === undefined) return undefined;
  const firstName = changes.firstName === undefined ? current.firstName : changes.firstName;
  const lastName = changes.lastName === undefined ? current.lastName : changes.lastName;
  if (!firstName?.trim()) throw new ConfigurationError('Completa Nombre(s) antes de guardar los apellidos.');
  return [firstName.trim(), lastName?.trim()].filter(Boolean).join(' ');
}
