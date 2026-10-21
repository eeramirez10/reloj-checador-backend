import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  ZK_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  ZK_INPORT: z.coerce.number().int().min(1).max(65535).default(5200),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(15).default(60),
  ZK_DRIVER: z.enum(['node', 'sdk-bridge']).default('node'),
  ZK_SDK_BRIDGE_URL: z.string().url().default('http://127.0.0.1:3100'),
  ZK_PHOTO_BRIDGE_URL: z.string().url().default('http://127.0.0.1:3200')
});

export type Env = z.infer<typeof schema>;
export const env: Env = schema.parse(process.env);
