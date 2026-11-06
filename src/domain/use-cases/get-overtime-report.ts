import type { BranchAttendanceRepository } from '../repositories/branch-attendance-repository.js';
import { emptyOvertimeTotals, overtimeTotals, type EmployeeOvertimeReport, type OvertimeReport, type OvertimeReportData, type OvertimeReportExport, type OvertimeReportQuery } from '../entities/overtime-report.js';
import type { BranchAttendanceFilters } from '../entities/branch-attendance.js';
import { effectiveVersion } from '../entities/employee-scheduling.js';
import { addDays } from '../entities/local-date.js';
import { buildEmployeeAttendanceCard } from './get-employee-attendance.js';

export class GetOvertimeReport {
  constructor(private readonly repository: BranchAttendanceRepository) {}
  async execute(query: OvertimeReportQuery, now = new Date()): Promise<OvertimeReport> {
    const report = await this.build(query, now);
    const totalPages = Math.ceil(report.totalEmployees / query.limit);
    const page = Math.min(query.page, Math.max(1, totalPages));
    return { ...report, page, pageSize: query.limit, totalPages, employees: report.employees.slice((page - 1) * query.limit, page * query.limit) };
  }

  async export(filters: BranchAttendanceFilters, now = new Date()): Promise<OvertimeReportExport> {
    return { ...await this.build(filters, now), generatedAt: now.toISOString() };
  }

  private async build(query: BranchAttendanceFilters, now: Date): Promise<OvertimeReportData> {
    const snapshot = await this.repository.exportSnapshot(query);
    const period = { from: query.from, to: query.to };
    const employees: EmployeeOvertimeReport[] = [];
    const totals = emptyOvertimeTotals();
    for (const employee of snapshot.employees) {
      const history = snapshot.histories.get(employee.id)!;
      let eligible = false;
      for (let date = query.from; date <= query.to; date = addDays(date,1)) {
        if (effectiveVersion(history.employeeSchedules,date)?.overtime?.enabled) { eligible = true; break; }
        if (date === query.to) break;
      }
      if (!eligible) continue;
      const card = buildEmployeeAttendanceCard(employee,history,period,now);
      const days = card.days.flatMap((day) => day.overtime ? [{ ...day, overtime: day.overtime }] : []);
      const summary = overtimeTotals(days.map((day) => day.overtime));
      employees.push({ employee, days, totals: summary });
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += summary[key];
    }
    return { branch: snapshot.branch, period, employeeStatus: query.employeeStatus, totals, totalEmployees: employees.length,
      employees };
  }
}
