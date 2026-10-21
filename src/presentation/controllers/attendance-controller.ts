import type { FastifyRequest } from 'fastify';
import { formatDateTimeInTimeZone, summarizeAttendance } from '../../domain/entities/attendance-summary.js';
import type { ApplicationServices } from '../services.js';
import { attendanceQuerySchema, reportSchema, summaryQuerySchema, userParams } from '../validators/attendance.js';

export class AttendanceController {
  constructor(private readonly services: Pick<ApplicationServices, 'attendance' | 'evaluation'>) {}

  list = async (request: FastifyRequest) => {
    const query = attendanceQuerySchema.parse(request.query);
    const logs = await this.services.attendance.list(query);
    return logs.map((log) => ({ ...log, occurredAtLocal: formatDateTimeInTimeZone(log.occurredAt, query.timeZone) }));
  };

  summary = async (request: FastifyRequest) => {
    const { userId } = userParams.parse(request.params);
    const query = summaryQuerySchema.parse(request.query);
    const logs = await this.services.attendance.list({ ...query, userId, limit: 5_000 });
    const local = (date: Date) => formatDateTimeInTimeZone(date, query.timeZone);
    const summaries = summarizeAttendance(logs, query.timeZone).map((summary) => ({
      ...summary,
      firstEntryLocal: summary.firstEntry && local(summary.firstEntry), lastExitLocal: summary.lastExit && local(summary.lastExit),
      openEntryLocal: summary.openEntry && local(summary.openEntry),
      sessions: summary.sessions.map((session) => ({ ...session, entryLocal: local(session.entry), exitLocal: session.exit && local(session.exit) })),
      punches: summary.punches.map((punch) => ({ ...punch, occurredAtLocal: local(punch.occurredAt) })),
    }));
    return { deviceId: query.deviceId, userId, timeZone: query.timeZone, displayFormat: 'YYYY-MM-DD HH:mm:ss', summaries };
  };

  daily = (request: FastifyRequest) => this.services.evaluation.report(reportSchema.parse(request.query));
  deductions = (request: FastifyRequest) => this.services.evaluation.deductions(reportSchema.parse(request.query));
  recalculate = () => this.services.evaluation.recalculate();
}
