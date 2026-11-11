import type { LeaveDay,LeaveInput,LeaveRequest } from './leave.js';

export function leaveOverlaps(input:LeaveInput,days:LeaveDay[],other:LeaveRequest):boolean {
  const boundaries = [input.kind,other.kind].sort().join(':')==='early_exit:late_arrival';
  if(boundaries && (!input.authorizedTime || !other.authorizedTime)) return false;
  return days.some(day=>other.details.days.some(previous=>day.date===previous.date && day.start<previous.end && previous.start<day.end));
}
