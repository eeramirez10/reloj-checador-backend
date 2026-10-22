import type { BranchAttendanceDatasource } from '../../domain/datasources/branch-attendance-datasource.js';
import type { BranchAttendanceRepository } from '../../domain/repositories/branch-attendance-repository.js';
import type { BranchAttendanceFilters, BranchAttendanceQuery } from '../../domain/entities/branch-attendance.js';

export class BranchAttendanceRepositoryImpl implements BranchAttendanceRepository {
  constructor(private readonly datasource: BranchAttendanceDatasource) {}
  snapshot(query: BranchAttendanceQuery) { return this.datasource.snapshot(query); }
  exportSnapshot(filters: BranchAttendanceFilters) { return this.datasource.exportSnapshot(filters); }
}
