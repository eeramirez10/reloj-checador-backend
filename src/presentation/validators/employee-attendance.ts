import { z } from 'zod';
import { dateSchema } from './organization.js';

export const employeeAttendanceQuerySchema = z.object({ from: dateSchema, to: dateSchema }).refine(
  ({ from, to }) => from <= to && (Date.parse(to) - Date.parse(from)) / 86_400_000 < 366,
  'Selecciona un periodo válido de hasta 366 días.');
