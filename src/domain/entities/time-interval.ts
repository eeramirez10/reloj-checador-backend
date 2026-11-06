export interface TimeInterval { start: number; end: number }

export function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  const ordered = intervals.filter((item) => item.end > item.start).map((item) => ({ ...item })).sort((a,b) => a.start - b.start);
  const result: TimeInterval[] = [];
  for (const item of ordered) {
    const previous = result.at(-1);
    if (previous && item.start <= previous.end) previous.end = Math.max(previous.end,item.end);
    else result.push(item);
  }
  return result;
}

export function intersectIntervals(intervals: TimeInterval[], bounds: TimeInterval): TimeInterval[] {
  return mergeIntervals(intervals.map((item) => ({ start: Math.max(item.start,bounds.start), end: Math.min(item.end,bounds.end) })));
}

export function subtractIntervals(intervals: TimeInterval[], excluded: TimeInterval[]): TimeInterval[] {
  let result = mergeIntervals(intervals);
  for (const cut of mergeIntervals(excluded)) result = result.flatMap((item) => {
    if (cut.end <= item.start || cut.start >= item.end) return [item];
    const parts: TimeInterval[] = [];
    if (cut.start > item.start) parts.push({ start: item.start, end: cut.start });
    if (cut.end < item.end) parts.push({ start: cut.end, end: item.end });
    return parts;
  });
  return result;
}

export function intervalSeconds(intervals: TimeInterval[]): number {
  return Math.floor(mergeIntervals(intervals).reduce((sum,item) => sum + item.end - item.start,0) / 1000);
}
