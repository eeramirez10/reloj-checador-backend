import { ConfigurationError } from '../errors/app-error.js';

export interface AttendanceFileInput { branchId: string; deviceId: string; fileName: string; content: string }
export interface ParsedFileRow {
  lineNumber: number; rawLine: string; userId?: string; date?: string; time?: string;
  prefix?: string; padding?: string; terminalCode?: string; marker?: string; issue?: string;
}
export type FileRowStatus = 'new' | 'existing' | 'duplicate' | 'invalid' | 'ambiguous';
export interface AttendanceFileRow extends ParsedFileRow {
  status: FileRowStatus; occurredAt?: string; employeeId?: string; employeeName?: string;
  unknownUser?: boolean; logId?: string; matchingTimes?: string[];
}
export interface AttendanceFileSummary {
  total: number; new: number; existing: number; duplicate: number; invalid: number; ambiguous: number; unknownUsers: number;
}
export interface AttendanceFilePreview {
  deviceId: string; branchId: string; fileName: string; timeZone: string; token: string;
  rows: AttendanceFileRow[]; summary: AttendanceFileSummary;
}
export interface AttendanceFileReceipt extends AttendanceFilePreview {
  id: string; createdAt: string; insertedCount: number;
}
export interface AttendanceFileResult extends AttendanceFileReceipt {
  alreadyImported: boolean; recalculated: boolean; recalculationError?: string;
}
export type AttendanceFileHistoryEntry = Pick<AttendanceFileReceipt,'id' | 'fileName' | 'createdAt' | 'insertedCount' | 'summary'>;

export function parseAttendanceFile(content: string): ParsedFileRow[] {
  if (!content.trim()) throw new ConfigurationError('El archivo está vacío.');
  const lines = content.replace(/^\uFEFF/,'').split(/\r\n|\n|\r/);
  if (lines.length > 10_001) throw new ConfigurationError('El archivo admite hasta 10 000 líneas.');
  const rows: ParsedFileRow[] = [];
  for (const [index,rawLine] of lines.entries()) {
    if (!rawLine.trim()) continue;
    const row: ParsedFileRow = { lineNumber: index + 1, rawLine };
    const match = /^(\d{2})(\d{7})(\d{5})(\d{2})-(\d{2})-(\d{2})(\d{3})(\d{2})(\d{2})([A-Za-z])$/.exec(rawLine.trim());
    if (!match) { rows.push({ ...row, issue: 'Formato no reconocido; se esperan 30 caracteres con ID, fecha y hora.' }); continue; }
    const [,prefix,user,padding,day,month,year,terminalCode,hour,minute,marker] = match;
    const date = `20${year}-${month}-${day}`;
    const instant = new Date(`${date}T00:00:00Z`);
    Object.assign(row,{ userId: user.replace(/^0+(?=\d)/,''), date, time: `${hour}:${minute}`, prefix, padding, terminalCode, marker });
    if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0,10) !== date || Number(hour) > 23 || Number(minute) > 59) row.issue = 'La fecha o la hora no es válida.';
    rows.push(row);
  }
  if (!rows.length) throw new ConfigurationError('El archivo no contiene checadas.');
  return rows;
}

export function summarizeFileRows(rows: AttendanceFileRow[]): AttendanceFileSummary {
  const summary: AttendanceFileSummary = { total: rows.length, new: 0, existing: 0, duplicate: 0, invalid: 0, ambiguous: 0, unknownUsers: 0 };
  const unknown = new Set<string>();
  for (const row of rows) { summary[row.status] += 1; if (row.unknownUser && row.status === 'new') unknown.add(row.userId!); }
  summary.unknownUsers = unknown.size;
  return summary;
}
