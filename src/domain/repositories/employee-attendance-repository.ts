import type { AttendancePeriod } from '../entities/employee-attendance.js';
import type { EmployeeScheduleVersion } from '../entities/employee-scheduling.js';
import type { Branch, WorkSchedule } from '../entities/organization.js';
import type { DailyEvaluation } from '../entities/schedule-evaluator.js';

export interface EmployeeAttendanceHistory {
  branches: Array<Pick<Branch, 'id' | 'name' | 'timeZone'>>;
  branchAssignments: Array<{ branchId: string; effectiveFrom: string }>;
  schedules: WorkSchedule[];
  assignments: Array<{ scheduleId: string | null; effectiveFrom: string }>;
  employeeSchedules: EmployeeScheduleVersion[];
  evaluations: Array<{ date: string; branchId: string | null; result: DailyEvaluation & {
    timeZone: string; branchName?: string; scheduleName?: string; scheduleSettings?: WorkSchedule['settings'];
  } }>;
}
export interface EmployeeAttendanceRepository {
  history(employeeId: string, period: AttendancePeriod): Promise<EmployeeAttendanceHistory>;
}
