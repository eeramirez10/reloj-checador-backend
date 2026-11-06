import { z } from 'zod';

export const attendanceFileSchema = z.object({
  branchId: z.string().uuid(), deviceId: z.string().uuid(),
  fileName: z.string().min(1).max(255).regex(/^[^/\\\x00-\x1f]+\.txt$/i,'Selecciona un archivo .txt.'),
  content: z.string().min(1).max(1_000_000),
}).strict();
export const attendanceFileCommitSchema = attendanceFileSchema.extend({ expectedToken: z.string().regex(/^[a-f0-9]{64}$/) });
export const attendanceFileHistorySchema = z.object({ deviceId: z.string().uuid() }).strict();
