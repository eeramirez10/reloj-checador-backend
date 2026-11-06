import type { FastifyRequest } from 'fastify';
import { formatDateTimeInTimeZone, summarizeAttendance } from '../../domain/entities/attendance-summary.js';
import type { ApplicationServices } from '../services.js';
import { attendanceQuerySchema, reportSchema, summaryQuerySchema, userParams } from '../validators/attendance.js';
import { addDays, type DailyEvaluation } from '../../domain/entities/schedule-evaluator.js';
import { branchAttendanceExportSchema, branchAttendanceQuerySchema } from '../validators/employee-attendance.js';

export class AttendanceController {
  constructor(private readonly services: Pick<ApplicationServices, 'attendance' | 'evaluation' | 'branchAttendance' | 'overtimeReport'>) {}

  cards = (request: FastifyRequest) => this.services.branchAttendance.execute(branchAttendanceQuerySchema.parse(request.query));
  exportCards = (request: FastifyRequest) => this.services.branchAttendance.export(branchAttendanceExportSchema.parse(request.query));
  overtime = (request: FastifyRequest) => this.services.overtimeReport.execute(branchAttendanceQuerySchema.parse(request.query));
  exportOvertime = (request: FastifyRequest) => this.services.overtimeReport.export(branchAttendanceExportSchema.parse(request.query));

  list = async (request: FastifyRequest) => {
    const query = attendanceQuerySchema.parse(request.query);
    const logs = await this.services.attendance.list(query);
    return logs.map((log) => ({ ...log, occurredAtLocal: formatDateTimeInTimeZone(log.occurredAt, query.timeZone) }));
  };

  summary = async (request: FastifyRequest) => {
    const { userId } = userParams.parse(request.params);
    const query = summaryQuerySchema.parse(request.query);
    const logs = await this.services.attendance.list({ deviceId: query.deviceId, userId, limit: 5_000 });
    const local = (date: Date) => formatDateTimeInTimeZone(date, query.timeZone);
    const dates = logs.map((log) => local(log.occurredAt).slice(0, 10)).sort();
    const subjects = [...new Set(logs.map((log) => log.employeeId).filter((id): id is string => Boolean(id)))];
    const reports = dates.length ? (await Promise.all(subjects.map((subjectId) => this.services.evaluation.report({
      from: addDays(query.from ? local(query.from).slice(0,10) : dates[0], -1), to: addDays(local(query.to ?? new Date()).slice(0,10), 1), subjectId,
    })))).flat() : [];
    const logIds = new Set(logs.map((log) => log.id));
    const from = query.from?.getTime() ?? Number.NEGATIVE_INFINITY;
    const to = query.to?.getTime() ?? Number.POSITIVE_INFINITY;
    const matching = reports.filter((report) => {
      const day = report.result as DailyEvaluation;
      return day.punches.some((punch) => logIds.has(punch.id) && Date.parse(punch.occurredAt) >= from && Date.parse(punch.occurredAt) <= to) || day.routes?.some((route) =>
        (logIds.has(route.entryLogId) || Boolean(route.exitLogId && logIds.has(route.exitLogId)))
        && Date.parse(route.segmentStart) <= to
        && (route.segmentEnd ? Date.parse(route.segmentEnd) : Date.now()) > from);
    });
    const summaries = summarizeAttendance(matching.map((report) => report.result as DailyEvaluation)).map((summary) => ({
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
