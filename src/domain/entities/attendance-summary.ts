export interface AttendanceSession {
  entry: Date;
  exit?: Date;
  workedMinutes?: number;
  inferredFromRoute?: boolean;
}

export interface DailyAttendanceSummary {
  date: string;
  firstEntry?: Date;
  lastExit?: Date;
  openEntry?: Date;
  workedMinutes: number | null;
  sessions: AttendanceSession[];
  punches: Array<{ occurredAt: Date; type: 'entry' | 'exit' | 'unclassified'; movement: string }>;
  inferred: boolean;
  issues: string[];
  missingMovements: string[];
}

interface SummaryDay {
  date: string; entry?: string; mealDeparture?: string; mealReturn?: string; exit?: string; workedMinutes?: number;
  punches: Array<{ id: string; occurredAt: string; movement: string }>; issues: string[]; missingMovements?: string[];
  routes?: Array<{ entryLogId: string; exitLogId: string | null; enteredAt: string; exitedAt: string | null; segmentStart: string; segmentEnd: string | null; workedSeconds?: number }>;
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

export function summarizeAttendance(days: SummaryDay[]): DailyAttendanceSummary[] {
  return [...days].sort((left, right) => left.date.localeCompare(right.date)).map((day) => {
    const sessions: AttendanceSession[] = [];
    const session = (entry: string | undefined, exit: string | undefined) => {
      if (!entry) return;
      sessions.push({ entry: new Date(entry), exit: exit ? new Date(exit) : undefined,
        workedMinutes: exit ? Math.round((Date.parse(exit) - Date.parse(entry)) / 60_000) : undefined });
    };
    if (day.routes?.length) {
      for (const route of day.routes) sessions.push({ entry: new Date(route.segmentStart), exit: route.segmentEnd ? new Date(route.segmentEnd) : undefined,
        workedMinutes: route.workedSeconds !== undefined ? Math.round(route.workedSeconds / 60) : undefined, inferredFromRoute: true });
      const routeLogIds = new Set(day.routes.flatMap((route) => [route.entryLogId,route.exitLogId]));
      const dailyPunches = day.punches.filter((punch) => !routeLogIds.has(punch.id));
      const movement = (kind: string) => dailyPunches.find((punch) => punch.movement === kind)?.occurredAt;
      session(movement('entry'),movement('meal_departure') ?? (day.workedMinutes !== undefined ? movement('exit') : undefined));
      session(movement('meal_return'),movement('exit'));
      sessions.sort((left,right) => left.entry.getTime() - right.entry.getTime());
    } else {
      session(day.entry, day.mealDeparture ?? (day.workedMinutes !== undefined ? day.exit : undefined));
      session(day.mealReturn, day.exit);
    }
    const lastSession = sessions.at(-1);
    const openRoute = day.routes?.find((route) => !route.exitedAt);
    const open = openRoute ? new Date(openRoute.enteredAt) : (!day.exit || day.routes?.length) && !lastSession?.exit ? lastSession?.entry : undefined;
    return {
      date: day.date, firstEntry: day.entry ? new Date(day.entry) : undefined, lastExit: day.exit ? new Date(day.exit) : undefined,
      openEntry: open, workedMinutes: day.workedMinutes ?? null, sessions, inferred: true,
      punches: day.punches.map((punch) => ({ occurredAt: new Date(punch.occurredAt), movement: punch.movement,
        type: punch.movement === 'entry' || punch.movement === 'meal_return' ? 'entry'
          : punch.movement === 'exit' || punch.movement === 'meal_departure' ? 'exit' : 'unclassified' })),
      issues: day.issues, missingMovements: day.missingMovements ?? [],
    };
  });
}
