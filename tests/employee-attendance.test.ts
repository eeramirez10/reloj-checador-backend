import { describe, expect, it } from 'vitest';
import { GetEmployeeAttendance } from '../src/domain/use-cases/get-employee-attendance.js';
import type { Employee } from '../src/domain/entities/employee.js';
import type { EmployeeAttendanceHistory } from '../src/domain/repositories/employee-attendance-repository.js';
import { dateAtLocalTime } from '../src/domain/entities/schedule-evaluator.js';

const employee: Employee = { id: 'employee', name: 'Empleado de prueba', branchId: 'branch', employmentStatus: 'active',
  createdAt: new Date(), updatedAt: new Date(), identificationStatus: 'confirmed', isActive: true, clockRecords: [] };
const history: EmployeeAttendanceHistory = {
  branches: [{ id: 'branch', name: 'Cancún', timeZone: 'America/Cancun' }], branchAssignments: [], assignments: [], employeeSchedules: [], evaluations: [],
  schedules: [{ id: 'base', branchId: 'branch', name: 'Jornada', effectiveFrom: '2026-10-01', isDefault: true,
    settings: { workDays: [1,2,3,4,5], entryTime: '08:30', exitTime: '17:30', mealEnabled: false,
      mealStart: '00:00', mealEnd: '00:00', mealDurationMinutes: 60 } }],
};
function service(data = history, person: Employee | undefined = employee) {
  return new GetEmployeeAttendance({ findById: async () => person }, { history: async () => data });
}

describe('employee attendance calendar', () => {
  it('includes every date and distinguishes missing records, local current days, future days and weekends', async () => {
    const now = dateAtLocalTime('2026-10-21','15:00','America/Cancun');
    const card = await service().execute(employee.id, { from: '2026-10-19', to: '2026-10-25' }, now);
    expect(card.days.map((day) => day.date)).toEqual(['2026-10-19','2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-10-24','2026-10-25']);
    expect(card.days.map((day) => day.status)).toEqual(['no_records','no_records','in_progress','upcoming','upcoming','day_off','day_off']);
    expect(card.summary.daysWithoutRecords).toBe(2);
    expect(card.summary.daysOff).toBe(2);
    expect(card.summary.calculableDays).toBe(0);
    expect(card.days.every((day) => day.workedMinutes === null && day.incidents.length === 0)).toBe(true);
  });

  it('uses the branch-local date and deadline rather than the server time zone', async () => {
    const now = new Date('2026-10-22T05:30:00Z');
    const card = await service().execute(employee.id, { from: '2026-10-22', to: '2026-10-22' }, now);
    expect(card.days[0].status).toBe('in_progress');
    expect(card.days[0].timeZone).toBe('America/Cancun');
  });

  it('does not use a future branch assignment or schedule to invent historical working days', async () => {
    const card = await service({ ...history, branchAssignments: [{ branchId: 'branch', effectiveFrom: '2026-10-20' }] })
      .execute(employee.id, { from: '2026-10-19', to: '2026-10-19' });
    expect(card.days[0].status).toBe('unconfigured');
    expect(card.days[0].scheduleSettings).toBeNull();
    expect(card.days[0].branchName).toBeNull();
    expect(card.summary.daysWithoutRecords).toBe(0);
  });

  it('returns a not-found error without reading attendance for a missing employee', async () => {
    let read = false;
    const useCase = new GetEmployeeAttendance({ findById: async () => undefined },
      { history: async () => { read = true; return history; } });
    await expect(useCase.execute('missing', { from: '2026-10-19', to: '2026-10-20' })).rejects.toThrow('Empleado no encontrado.');
    expect(read).toBe(false);
  });
});
