import { z } from 'zod';

export const deviceSchema = z.object({
  name: z.string().trim().min(1).max(120), ipAddress: z.string().ip({ version: 'v4' }),
  tcpPort: z.number().int().min(1).max(65535).optional(), driver: z.enum(['node', 'sdk-bridge']).optional(),
  enabled: z.boolean().optional(), syncIntervalSeconds: z.number().int().min(15).max(86400).optional(),
});
export const createDeviceSchema = deviceSchema.extend({ branchId: z.string().uuid() });
export const photoSyncSchema = z.object({
  userIds: z.array(z.string().trim().min(1).max(32)).min(1).max(25)
    .refine((ids) => new Set(ids).size === ids.length, 'No repitas IDs de usuario.').optional(),
});
export const deviceFilterSchema = z.object({ deviceId: z.string().uuid().optional() });
export const userListSchema = deviceFilterSchema.extend({ limit: z.coerce.number().int().min(1).max(500).default(100) });
export const photoParams = z.object({ deviceId: z.string().uuid(), userId: z.string().min(1) });
