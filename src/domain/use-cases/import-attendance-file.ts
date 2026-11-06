import { parseAttendanceFile, type AttendanceFileInput, type AttendanceFileResult } from '../entities/attendance-file.js';
import { errorMessage } from '../errors/app-error.js';
import type { AttendanceFileRepository } from '../repositories/attendance-file-repository.js';

export class ImportAttendanceFile {
  constructor(private readonly repository: AttendanceFileRepository, private readonly recalculate: () => Promise<unknown>) {}

  preview(input: AttendanceFileInput) { return this.repository.preview(input,parseAttendanceFile(input.content)); }
  history(deviceId: string) { return this.repository.history(deviceId); }

  async execute(input: AttendanceFileInput, expectedToken: string): Promise<AttendanceFileResult> {
    const { receipt,alreadyImported } = await this.repository.import(input,parseAttendanceFile(input.content),expectedToken);
    try {
      await this.recalculate();
      return { ...receipt, alreadyImported, recalculated: true };
    } catch (error) {
      return { ...receipt, alreadyImported, recalculated: false, recalculationError: errorMessage(error) };
    }
  }
}
