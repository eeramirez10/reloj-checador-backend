import { formatDateTimeInTimeZone } from '../entities/attendance-summary.js';
import { evaluateDay, type DailyEvaluation } from '../entities/schedule-evaluator.js';
import type { EvaluationSnapshot, SubjectLog } from '../repositories/evaluation-repository.js';
import { SubjectAttendanceContext, type AttendanceContext, type EvaluatedAttendanceDay } from './attendance-context.js';
import { applyDailyOvertime, combineOvertimeDays } from './attendance-overtime.js';
import { evaluateRoutes, routeRepeatWindow, type RouteJourney } from './evaluate-route-attendance.js';
import { dateAtLocalTime } from '../entities/local-date.js';
import { applyLeaveAuthorizations, authorizedSchedule, authorizationsForDay } from '../entities/leave-attendance.js';

export function evaluateSubjectAttendance(logs: SubjectLog[], snapshot: EvaluationSnapshot, now = new Date(), fallbackSubject?: SubjectLog): EvaluatedAttendanceDay[] {
  const ordered = [...logs].sort((a,b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  const subject = ordered[0] ?? fallbackSubject;
  if (!subject) return [];
  const resolver = new SubjectAttendanceContext(snapshot,subject);
  const leaves = (snapshot.approvedLeaves ?? []).filter((request) => request.employeeId === subject.subjectId);
  const dailyGroups = new Map<string, { context: AttendanceContext; logs: SubjectLog[] }>();
  const journeys: RouteJourney[] = [];
  let open: RouteJourney | undefined;
  let previousRoute: RouteJourney | undefined;
  for (const log of ordered) {
    if (open) {
      const elapsed = log.occurredAt.getTime() - open.entry.occurredAt.getTime();
      if (elapsed < 60_000 || elapsed <= routeRepeatWindow(open.context)) open.duplicates.push(log);
      else { open.exit = log; previousRoute = open; open = undefined; }
      continue;
    }
    if (previousRoute?.exit && log.occurredAt.getTime() - previousRoute.exit.occurredAt.getTime() < 60_000) {
      previousRoute.duplicates.push(log); continue;
    }
    const context = resolver.locate(log);
    if (context.overtime.enabled && context.overtime.workMode === 'route') {
      open = { entry: log, duplicates: [], context }; journeys.push(open); continue;
    }
    previousRoute = undefined;
    const key = context.date;
    const group = dailyGroups.get(key) ?? { context, logs: [] };
    group.logs.push(log); dailyGroups.set(key,group);
  }
  const days: EvaluatedAttendanceDay[] = [];
  const routeDays = evaluateRoutes(journeys,resolver,now);
  const routeDates = new Set(routeDays.map((day) => day.date));
  for (const request of leaves) for (const day of request.details.days) {
    if (!dailyGroups.has(day.date) && !routeDates.has(day.date)) dailyGroups.set(day.date, { context: resolver.at(day.date, resolver.branchAt(day.date, snapshot.branches.find((branch) => branch.id === subject.branchId))), logs: [] });
  }
  for (const { context,logs: punches } of dailyGroups.values()) {
    const zone = context.branch?.timeZone ?? 'America/Mexico_City';
    const authorizations = authorizationsForDay(leaves, context.date);
    const observedExit=punches.length>1 && punches.at(-1)!.occurredAt.getTime()-punches[0].occurredAt.getTime()>=60000 ? formatDateTimeInTimeZone(punches.at(-1)!.occurredAt,zone).slice(11,16) : undefined;
    const daily: DailyEvaluation = context.schedule ? evaluateDay(context.date,punches,authorizedSchedule(context.schedule.settings, authorizations,observedExit),context.policy?.settings,zone,now,
      { firstPunchIsEntry: context.overtime.enabled || authorizations.some((item) => ['late_arrival','early_exit','home_office','client_visit'].includes(item.kind)) }) : { date: context.date, status: 'unconfigured', punches: punches.map((log) => ({ id: log.id,
        occurredAt: log.occurredAt.toISOString(), localTime: formatDateTimeInTimeZone(log.occurredAt,zone), movement: 'unclassified' })),
      issues: ['Asigna una jornada laboral de sucursal o individual vigente para identificar esta jornada.'], incidents: [] };
    applyDailyOvertime(daily,context);
    days.push({ ...context, subject: punches[0] ?? subject, logs: punches, daily });
  }
  days.push(...routeDays);
  const merged = new Map<string, EvaluatedAttendanceDay>();
  for (const item of days.sort((a,b) => a.subject.occurredAt.getTime() - b.subject.occurredAt.getTime())) {
    const previous = merged.get(item.date);
    if (!previous) { merged.set(item.date,item); continue; }
    const values = [previous.daily,item.daily];
    const punches = [...previous.daily.punches,...item.daily.punches].sort((a,b) => a.occurredAt.localeCompare(b.occurredAt));
    previous.logs.push(...item.logs);
    const routes = values.flatMap((day) => day.routes ?? []);
    const incidents = [previous,item].flatMap((day) => day.daily.incidents.filter((incident) => {
      if (incident.kind !== 'arrival' || !day.schedule) return true;
      const expected = dateAtLocalTime(day.date,day.schedule.settings.entryTime,day.branch?.timeZone ?? 'America/Mexico_City').getTime();
      return !routes.some((route) => Date.parse(route.segmentStart) <= expected && (!route.segmentEnd || Date.parse(route.segmentEnd) > expected));
    })).sort((a,b) => a.occurredAt.localeCompare(b.occurredAt));
    previous.daily = { ...previous.daily, punches, entry: punches.find((punch) => punch.movement === 'entry')?.occurredAt,
      exit: punches.filter((punch) => punch.movement === 'exit').at(-1)?.occurredAt,
      mealDeparture: values.find((day) => day.mealDeparture)?.mealDeparture, mealReturn: values.find((day) => day.mealReturn)?.mealReturn,
      expectedMealReturn: values.find((day) => day.expectedMealReturn)?.expectedMealReturn, mealMinutes: values.find((day) => day.mealMinutes !== undefined)?.mealMinutes,
      workedMinutes: values.every((day) => day.workedMinutes !== undefined) ? values.reduce((sum,day) => sum + day.workedMinutes!,0) : undefined,
      status: values.some((day) => day.status === 'in_progress') ? 'in_progress' : values.find((day) => !['complete','day_off'].includes(day.status))?.status ?? previous.daily.status,
      routes, issues: [...new Set(values.flatMap((day) => day.issues))],
      incidents: incidents.filter((incident,index,all) => all.findIndex((value) => value.kind === incident.kind) === index),
      missingMovements: [...new Set(values.flatMap((day) => day.missingMovements ?? []))],
      overtime: combineOvertimeDays(values.flatMap((day) => day.overtime ? [day.overtime] : [])) };
  }
  for (const item of merged.values()) applyLeaveAuthorizations(item.daily, authorizationsForDay(leaves, item.date), item.schedule?.settings, item.policy?.settings, item.branch?.timeZone ?? 'America/Mexico_City');
  return [...merged.values()].sort((a,b) => a.date.localeCompare(b.date));
}
