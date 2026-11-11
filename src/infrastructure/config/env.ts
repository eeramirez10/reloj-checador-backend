import 'dotenv/config';
import { z } from 'zod';
import { whatsappEnvironment } from './whatsapp.js';
import { databaseForEnvironment } from './database-environment.js';
import { emailEnvironment } from './email.js';

const schema = z.object({
  ...whatsappEnvironment,
  ...emailEnvironment,
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  APP_ENV: z.enum(['development','production','test']).default('production'),
  PRODUCTION_DATABASE_URL: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  SYNC_ENABLED: z.enum(['true','false']).default('true').transform(value => value === 'true'),
  AUTH_ALLOWED_ORIGINS: z.string().default('http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3005').transform(value => value.split(',').map(origin => new URL(origin.trim()).origin)),
  AUTH_COOKIE_SECURE: z.enum(['true','false']).default(process.env.NODE_ENV === 'production' ? 'true' : 'false').transform(value => value === 'true'),
  AUTH_SESSION_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  ZK_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  ZK_OPERATION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120_000),
  ZK_INPORT: z.coerce.number().int().min(1).max(65535).default(5200),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(60),
  ZK_DRIVER: z.enum(['node', 'sdk-bridge']).default('node'),
  ZK_SDK_BRIDGE_URL: z.string().url().default('http://127.0.0.1:3100'),
  ZK_PHOTO_BRIDGE_URL: z.string().url().default('http://127.0.0.1:3200')
}).superRefine((configuration, context) => {
  if (!['http:','https:'].includes(new URL(configuration.APP_PUBLIC_URL).protocol)) context.addIssue({ code: 'custom',path: ['APP_PUBLIC_URL'],message: 'Utiliza una URL HTTP o HTTPS.' });
  if (configuration.EMAIL_ENABLED) {
    for (const field of ['EMAIL_ENCRYPTION_KEY','MICROSOFT_TENANT_ID','MICROSOFT_CLIENT_ID','MICROSOFT_CLIENT_SECRET','MICROSOFT_SENDER_ID'] as const) {
      if (!configuration[field]) context.addIssue({ code: 'custom',path: [field],message: `Configura ${field} para enviar correos.` });
    }
  }
  if (configuration.APP_ENV !== 'development') return;
  if (configuration.SYNC_ENABLED) context.addIssue({ code: 'custom', path: ['SYNC_ENABLED'], message: 'Desactiva la sincronización automática en desarrollo: SYNC_ENABLED=false.' });
  if (configuration.TWILIO_WHATSAPP_ENABLED) context.addIssue({ code: 'custom', path: ['TWILIO_WHATSAPP_ENABLED'], message: 'Desactiva los envíos de WhatsApp en desarrollo: TWILIO_WHATSAPP_ENABLED=false.' });
  if (configuration.EMAIL_ENABLED) context.addIssue({ code: 'custom',path: ['EMAIL_ENABLED'],message: 'Desactiva los envíos reales en desarrollo: EMAIL_ENABLED=false.' });
});

export type Env = z.infer<typeof schema>;
export function parseEnvironment(value: unknown): Env {
  const configuration = schema.parse(value);
  databaseForEnvironment(configuration);
  return configuration;
}
export const env: Env = parseEnvironment(process.env);
