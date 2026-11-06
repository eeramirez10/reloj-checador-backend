import type { AttendanceFileInput, AttendanceFilePreview, AttendanceFileReceipt, AttendanceFileHistoryEntry, ParsedFileRow } from '../entities/attendance-file.js';

export interface AttendanceFileRepository {
  preview(input: AttendanceFileInput, rows: ParsedFileRow[]): Promise<AttendanceFilePreview>;
  import(input: AttendanceFileInput, rows: ParsedFileRow[], expectedToken: string): Promise<{ receipt: AttendanceFileReceipt; alreadyImported: boolean }>;
  history(deviceId: string): Promise<AttendanceFileHistoryEntry[]>;
}
