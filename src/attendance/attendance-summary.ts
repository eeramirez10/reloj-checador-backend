import type { AttendanceLog } from './attendance-repository.js';

export interface AttendanceSession {
  entry: Date;
  exit?: Date;
  workedMinutes?: number;
}

export interface DailyAttendanceSummary {
  date: string;
  firstEntry?: Date;
  lastExit?: Date;
  openEntry?: Date;
  workedMinutes: number;
  sessions: AttendanceSession[];
  punches: Array<{ occurredAt: Date; type: 'entry' | 'exit' }>;
  inferred: boolean;
}

function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function formatDateTimeInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

export function summarizeAttendance(logs: AttendanceLog[], timeZone: string): DailyAttendanceSummary[] {
  const byDate = new Map<string, AttendanceLog[]>();
  for (const log of logs) {
    const date = localDate(log.occurredAt, timeZone);
    byDate.set(date, [...(byDate.get(date) ?? []), log]);
  }

  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, dailyLogs]) => {
    const ordered = dailyLogs.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const sessions: AttendanceSession[] = [];
    const punches: DailyAttendanceSummary['punches'] = [];
    let workedMinutes = 0;
    let openSession: AttendanceSession | undefined;
    let lastExit: Date | undefined;
    let inferred = false;

    ordered.forEach((log) => {
      const explicitType = getPunchType(log.punchState);
      const type = explicitType ?? (openSession ? 'exit' : 'entry');
      if (!explicitType) inferred = true;

      if (type === 'entry') {
        openSession = { entry: log.occurredAt };
        sessions.push(openSession);
        punches.push({ occurredAt: log.occurredAt, type: 'entry' });
        return;
      }

      lastExit = log.occurredAt;
      punches.push({ occurredAt: log.occurredAt, type: 'exit' });
      if (!openSession) return;

      openSession.exit = log.occurredAt;
      openSession.workedMinutes = Math.round((log.occurredAt.getTime() - openSession.entry.getTime()) / 60_000);
      workedMinutes += openSession.workedMinutes;
      openSession = undefined;
    });

    return {
      date,
      firstEntry: sessions[0]?.entry,
      lastExit,
      openEntry: openSession?.entry,
      workedMinutes,
      sessions,
      punches,
      inferred
    };
  });
}

function getPunchType(punchState?: number): 'entry' | 'exit' | undefined {
  if (punchState === 0 || punchState === 3 || punchState === 4) return 'entry';
  if (punchState === 1 || punchState === 2 || punchState === 5) return 'exit';
  return undefined;
}
