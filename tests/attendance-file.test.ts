import { describe, expect, it } from 'vitest';
import { parseAttendanceFile } from '../src/domain/entities/attendance-file.js';
import { attendanceFileSchema } from '../src/presentation/validators/attendance-file.js';

describe('Talavie attendance files', () => {
  it('reads Cancun and Queretaro IDs, dates, times and metadata without interpreting the marker as a movement', () => {
    const rows = parseAttendanceFile('\uFEFF0100006030000015-10-260011802B\r\n\r\n0100005140000016-10-260010752E  \r\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ lineNumber: 1, userId: '603', date: '2026-10-15', time: '18:02', prefix: '01', padding: '00000', terminalCode: '001', marker: 'B' });
    expect(rows[1]).toMatchObject({ lineNumber: 3, userId: '514', date: '2026-10-16', time: '07:52', marker: 'E' });
    expect(rows[1].rawLine).toBe('0100005140000016-10-260010752E  ');
  });
  it('reports invalid calendar dates, invalid hours and malformed lines without losing their original line numbers', () => {
    const rows = parseAttendanceFile('0100006030000031-02-260011802B\n0100006030000015-10-260012460B\ninvalid');
    expect(rows.every((row) => row.issue)).toBe(true);
    expect(rows.map((row) => row.lineNumber)).toEqual([1,2,3]);
    expect(parseAttendanceFile('0100006030000029-02-240011802B')[0].issue).toBeUndefined();
  });
  it('rejects empty and oversized files and unsafe filenames', () => {
    expect(() => parseAttendanceFile(' \n')).toThrow();
    expect(() => parseAttendanceFile('x\n'.repeat(10002))).toThrow();
    const input = { branchId: 'e6cf187e-63a0-47ab-afae-53a6fe336ca1', deviceId: '717a1455-41ec-411c-958c-7f958ba92028', content: 'x' };
    expect(attendanceFileSchema.safeParse({ ...input, fileName: '../file.txt' }).success).toBe(false);
    expect(attendanceFileSchema.safeParse({ ...input, fileName: 'Talavie.TXT' }).success).toBe(true);
  });
});
