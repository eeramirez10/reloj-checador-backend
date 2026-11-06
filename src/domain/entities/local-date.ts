import { formatDateTimeInTimeZone } from './attendance-summary.js';

export function addDays(date: string, count: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0,10);
}

export function dateAtLocalTime(date: string, time: string, timeZone: string): Date {
  const target = `${date}T${time}:00`;
  const wallTime = Date.parse(`${target}Z`);
  let instant = wallTime;
  for (let index = 0; index < 4; index += 1) {
    const local = formatDateTimeInTimeZone(new Date(instant),timeZone).replace(' ','T');
    const offset = Date.parse(`${local}Z`) - wallTime;
    if (offset === 0) return new Date(instant);
    instant -= offset;
  }
  throw new Error(`La hora ${target} no existe en ${timeZone}.`);
}
