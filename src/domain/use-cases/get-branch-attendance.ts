import type { BranchAttendanceCards, BranchAttendanceExport, BranchAttendanceFilters, BranchAttendanceQuery } from '../entities/branch-attendance.js';
import type { BranchAttendanceRepository, BranchAttendanceSnapshot } from '../repositories/branch-attendance-repository.js';
import { buildEmployeeAttendanceCard } from './get-employee-attendance.js';

function buildReport(snapshot: BranchAttendanceSnapshot, filters: BranchAttendanceFilters, now: Date): BranchAttendanceExport {
  const period = { from: filters.from, to: filters.to };
  return { branch: snapshot.branch, period, employeeStatus: filters.employeeStatus, totalEmployees: snapshot.totalEmployees,...(snapshot.companyFilter ? {companyFilter: snapshot.companyFilter} : {}),
    cards: snapshot.employees.map((employee) => buildEmployeeAttendanceCard(employee, snapshot.histories.get(employee.id)!, period, now)) };
}

export class GetBranchAttendance {
  constructor(private readonly repository: BranchAttendanceRepository) {}

  async execute(query: BranchAttendanceQuery, now = new Date()): Promise<BranchAttendanceCards> {
    const snapshot = await this.repository.snapshot(query);
    return { ...buildReport(snapshot, query, now), page: snapshot.page, pageSize: query.limit,
      totalPages: Math.ceil(snapshot.totalEmployees / query.limit) };
  }

  async export(filters: BranchAttendanceFilters, now = new Date()) {
    const snapshot = await this.repository.exportSnapshot(filters);
    return { ...buildReport(snapshot, filters, now), generatedAt: now.toISOString() };
  }
}
