import type { AttendanceFileDatasource } from '../../domain/datasources/attendance-file-datasource.js';
import type { AttendanceFileInput, ParsedFileRow } from '../../domain/entities/attendance-file.js';
import type { AttendanceFileRepository } from '../../domain/repositories/attendance-file-repository.js';

export class AttendanceFileRepositoryImpl implements AttendanceFileRepository {
  constructor(private readonly datasource: AttendanceFileDatasource) {}
  preview(input: AttendanceFileInput, rows: ParsedFileRow[]) { return this.datasource.preview(input,rows); }
  import(input: AttendanceFileInput, rows: ParsedFileRow[], token: string) { return this.datasource.import(input,rows,token); }
  history(deviceId: string) { return this.datasource.history(deviceId); }
}
