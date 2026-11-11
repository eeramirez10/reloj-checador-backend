import { z } from 'zod';
export const emailEnvironment = {
  EMAIL_ENABLED: z.enum(['true','false']).default('false').transform(value => value === 'true'),
  EMAIL_ENCRYPTION_KEY: z.string().regex(/^$|^[a-fA-F0-9]{64}$/).default(''),
  APP_PUBLIC_URL: z.string().url().default('http://tuvansa-server.dyndns.org:8080/reloj/'),
  MICROSOFT_TENANT_ID: z.string().default(''),
  MICROSOFT_CLIENT_ID: z.string().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().default(''),
  MICROSOFT_SENDER_ID: z.string().default(''),
};
export interface EmailSettings { encryptionKey: string; publicUrl: string; enabled: boolean }
