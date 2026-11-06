const millisecondsPerMinute = 60_000;

export function latenessMinutes(actual: number, expected: number): number {
  return Math.max(0, Math.floor(actual / millisecondsPerMinute) - Math.floor(expected / millisecondsPerMinute));
}

export function toleranceDeadline(expected: number, toleranceMinutes: number): number {
  return (Math.floor(expected / millisecondsPerMinute) + toleranceMinutes + 1) * millisecondsPerMinute;
}
