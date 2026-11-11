import type { BranchAttendanceFilters, BranchAttendanceQuery } from './branch-attendance.js';
import type { EmployeeAttendanceCard, EmployeeAttendanceDay } from './employee-attendance.js';
import type { OvertimeDay } from './overtime.js';
import type { CompanySelection } from './company.js';

export interface OvertimeTotals {
  grossSeconds: number; dailyRestSeconds: number; additionalRestSeconds: number; netSeconds: number;
  calculatedDays: number; pendingDays: number; noRecordDays: number;
}
export interface EmployeeOvertimeReport {
  employee: EmployeeAttendanceCard['employee'];
  days: Array<EmployeeAttendanceDay & { overtime: OvertimeDay }>;
  totals: OvertimeTotals;
}
export interface OvertimeReportData {
  search?: string;
  companyFilter?: CompanySelection;
  branch: { id: string; name: string; timeZone: string };
  period: { from: string; to: string };
  employeeStatus: BranchAttendanceFilters['employeeStatus'];
  employees: EmployeeOvertimeReport[]; totals: OvertimeTotals;
  totalEmployees: number;
}
export interface OvertimeReport extends OvertimeReportData { page: number; pageSize: number; totalPages: number }
export interface OvertimeReportExport extends OvertimeReportData { generatedAt: string }
export type OvertimeReportQuery = BranchAttendanceQuery;

export function emptyOvertimeTotals(): OvertimeTotals {
  return { grossSeconds: 0, dailyRestSeconds: 0, additionalRestSeconds: 0, netSeconds: 0, calculatedDays: 0, pendingDays: 0, noRecordDays: 0 };
}

export function overtimeTotals(days: OvertimeDay[]): OvertimeTotals {
  const totals = emptyOvertimeTotals();
  for (const day of days) {
    if (day.status === 'pending') { totals.pendingDays += 1; continue; }
    if (day.status === 'no_records') { totals.noRecordDays += 1; continue; }
    totals.calculatedDays += 1;
    totals.grossSeconds += day.grossSeconds!;
    totals.dailyRestSeconds += day.dailyRestSeconds!;
    totals.additionalRestSeconds += day.additionalRestSeconds!;
    totals.netSeconds += day.netSeconds!;
  }
  return totals;
}
