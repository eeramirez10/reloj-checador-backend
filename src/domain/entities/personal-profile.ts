import { ConfigurationError } from '../errors/app-error.js';

export interface UserProfilePatch {
  firstName?: string | null; lastName?: string | null; rfc?: string | null;
  socialSecurityNumber?: string | null; displayName?: string | null; employeeId?: string | null;
}

export function getUpdatedProfileName(current: { firstName: string | null; lastName: string | null },
  changes: { firstName?: string | null; lastName?: string | null }): string | undefined {
  if (changes.firstName === undefined && changes.lastName === undefined) return undefined;
  const firstName = changes.firstName === undefined ? current.firstName : changes.firstName;
  const lastName = changes.lastName === undefined ? current.lastName : changes.lastName;
  if (!firstName?.trim()) throw new ConfigurationError('Completa Nombre(s) antes de guardar los apellidos.');
  return [firstName.trim(), lastName?.trim()].filter(Boolean).join(' ');
}
