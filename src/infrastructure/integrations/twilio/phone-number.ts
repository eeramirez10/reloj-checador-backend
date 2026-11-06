import { getCountries, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { ConfigurationError } from '../../../domain/errors/app-error.js';

export function phoneCountry(value: string): CountryCode {
  if (!getCountries().includes(value as CountryCode)) throw new ConfigurationError('PHONE_DEFAULT_COUNTRY no es un país válido.');
  return value as CountryCode;
}

export function normalizePhoneNumber(value: string, country: CountryCode): string {
  const text = value.trim();
  const phone = parsePhoneNumberFromString(text, { defaultCountry: country, extract: false });
  if (!phone?.isValid()) throw new ConfigurationError('Indica un número de WhatsApp válido, con código de país.');
  if (text.startsWith('+') && phone.number !== text.replace(/[\s().-]/g, '')) throw new ConfigurationError('Revisa el prefijo internacional del número de WhatsApp.');
  return phone.number;
}

export function normalizeWhatsAppAddress(value: string, country: CountryCode): string {
  if (!value.startsWith('whatsapp:+') || value.slice(9).includes('whatsapp:')) throw new ConfigurationError('La dirección debe pertenecer al canal WhatsApp.');
  return normalizePhoneNumber(value.slice(9), country);
}
