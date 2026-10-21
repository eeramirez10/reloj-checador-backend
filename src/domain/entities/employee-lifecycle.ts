import { ConfigurationError } from '../errors/app-error.js';
import { formatDateTimeInTimeZone } from './attendance-summary.js';

export function assertEditableEmployee(identificationStatus: string): void {
  if (identificationStatus === 'merged') throw new ConfigurationError('Esta ficha es histórica y no puede cambiar de estado.');
}

export function employeeStatusTransition(current: { isActive: boolean; terminationDate: string | null },
  isActive: boolean, timeZone: string, now: Date) {
  if (current.isActive === isActive) return undefined;
  const localDate = formatDateTimeInTimeZone(now, timeZone).slice(0, 10);
  return {
    eventType: isActive ? 'reactivated' : 'terminated', previousIsActive: current.isActive, isActive,
    localDate, timeZone, previousTerminationDate: current.terminationDate,
    terminationDate: isActive ? null : localDate, createdAt: now,
  };
}
