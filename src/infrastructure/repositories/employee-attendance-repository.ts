import type { EmployeeAttendanceDatasource } from '../../domain/datasources/employee-attendance-datasource.js';
import type { EmployeeAttendanceRepository } from '../../domain/repositories/employee-attendance-repository.js';
import type { AttendancePeriod } from '../../domain/entities/employee-attendance.js';

export class EmployeeAttendanceRepositoryImpl implements EmployeeAttendanceRepository {
  constructor(private readonly datasource: EmployeeAttendanceDatasource) {}
  history(employeeId: string, period: AttendancePeriod) { return this.datasource.history(employeeId, period); }
}
