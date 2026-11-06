import 'dotenv/config';
import { z } from 'zod';
import { whatsappEnvironment } from './whatsapp.js';

const schema = z.object({
  ...whatsappEnvironment,
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
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
});

export type Env = z.infer<typeof schema>;
export const env: Env = schema.parse(process.env);
