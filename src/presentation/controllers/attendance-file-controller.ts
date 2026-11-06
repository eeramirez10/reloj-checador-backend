import type { FastifyRequest } from 'fastify';
import type { ImportAttendanceFile } from '../../domain/use-cases/import-attendance-file.js';
import { attendanceFileCommitSchema, attendanceFileHistorySchema, attendanceFileSchema } from '../validators/attendance-file.js';

export class AttendanceFileController {
  constructor(private readonly service: ImportAttendanceFile) {}
  preview = (request: FastifyRequest) => this.service.preview(attendanceFileSchema.parse(request.body));
  import = (request: FastifyRequest) => {
    const { expectedToken,...input } = attendanceFileCommitSchema.parse(request.body);
    return this.service.execute(input,expectedToken);
  };
  history = (request: FastifyRequest) => this.service.history(attendanceFileHistorySchema.parse(request.query).deviceId);
}
