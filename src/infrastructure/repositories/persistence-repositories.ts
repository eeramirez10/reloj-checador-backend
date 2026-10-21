import type { AttendanceDatasource, DeviceDatasource, EmployeeDatasource, OrganizationDatasource, SyncDatasource,
  DeviceUserDatasource, DeviceUserPhotoDatasource, UserProfileDatasource } from '../../domain/datasources/persistence.js';
import type { ZktecoAttendanceEvent, ZktecoUser } from '../../domain/datasources/device-client.js';
import type { AttendanceFilters, EmployeeFilters } from '../../domain/dtos/filters.js';
import type { CreateDeviceInput } from '../../domain/entities/device.js';
import type { EmployeeCatalogRecord } from '../../domain/entities/employee.js';
import type { AssignmentTargets, BranchInput, BranchPolicy, OrganizationAssignment, WorkSchedule } from '../../domain/entities/organization.js';
import type { UserProfilePatch } from '../../domain/entities/personal-profile.js';
import type { SyncType } from '../../domain/entities/sync-run.js';
import type { AttendanceRepository } from '../../domain/repositories/attendance-repository.js';
import type { DeviceRepository } from '../../domain/repositories/device-repository.js';
import type { EmployeeRepository } from '../../domain/repositories/employee-repository.js';
import type { OrganizationRepository } from '../../domain/repositories/organization-repository.js';
import type { SyncRepository } from '../../domain/repositories/sync-repository.js';
import type { DeviceUserPhotoRepository, DeviceUserRepository, UserProfileRepository } from '../../domain/repositories/user-repository.js';

export class DeviceRepositoryImpl implements DeviceRepository {
  constructor(private readonly datasource: DeviceDatasource) {}
  list() { return this.datasource.list(); }
  listEnabled() { return this.datasource.listEnabled(); }
  findById(id: string) { return this.datasource.findById(id); }
  create(input: CreateDeviceInput) { return this.datasource.create(input); }
  update(id: string, input: Partial<CreateDeviceInput>) { return this.datasource.update(id, input); }
  softDelete(id: string) { return this.datasource.softDelete(id); }
}

export class AttendanceRepositoryImpl implements AttendanceRepository {
  constructor(private readonly datasource: AttendanceDatasource) {}
  insertIfNew(deviceId: string, event: ZktecoAttendanceEvent) { return this.datasource.insertIfNew(deviceId, event); }
  list(filters: AttendanceFilters) { return this.datasource.list(filters); }
}

export class EmployeeRepositoryImpl implements EmployeeRepository {
  constructor(private readonly datasource: EmployeeDatasource) {}
  findById(id: string) { return this.datasource.findById(id); }
  list(filters: EmployeeFilters) { return this.datasource.list(filters); }
  upsert(employee: EmployeeCatalogRecord) { return this.datasource.upsert(employee); }
  update(id: string, fields: Record<string, string | null>, isActive?: boolean) { return this.datasource.update(id, fields, isActive); }
}

export class OrganizationRepositoryImpl implements OrganizationRepository {
  constructor(private readonly datasource: OrganizationDatasource) {}
  refreshCurrentBranches() { return this.datasource.refreshCurrentBranches(); }
  listBranches() { return this.datasource.listBranches(); }
  saveBranch(input: BranchInput, id?: string) { return this.datasource.saveBranch(input, id); }
  listPolicies() { return this.datasource.listPolicies(); }
  addPolicy(branchId: string, input: Omit<BranchPolicy, 'id' | 'branchId'>) { return this.datasource.addPolicy(branchId, input); }
  listSchedules() { return this.datasource.listSchedules(); }
  addSchedule(input: Omit<WorkSchedule, 'id'>) { return this.datasource.addSchedule(input); }
  listAssignments() { return this.datasource.listAssignments(); }
  assignSchedule(scheduleId: string, targets: AssignmentTargets) { return this.datasource.assignSchedule(scheduleId, targets); }
  assignBranch(branchId: string, targets: AssignmentTargets & { deviceIds?: string[] }) { return this.datasource.assignBranch(branchId, targets); }
  assign(input: OrganizationAssignment) { return this.datasource.assign(input); }
}

export class SyncRepositoryImpl implements SyncRepository {
  constructor(private readonly datasource: SyncDatasource) {}
  start(deviceId: string, syncType?: SyncType) { return this.datasource.start(deviceId, syncType); }
  finish(id: string, status: 'succeeded' | 'failed', counts: { received: number; inserted: number }, errorMessage?: string) {
    return this.datasource.finish(id, status, counts, errorMessage);
  }
  list(deviceId?: string) { return this.datasource.list(deviceId); }
}

export class DeviceUserRepositoryImpl implements DeviceUserRepository {
  constructor(private readonly datasource: DeviceUserDatasource) {}
  ensureFromAttendance(deviceId: string, userIds: string[]) { return this.datasource.ensureFromAttendance(deviceId, userIds); }
  upsert(deviceId: string, user: ZktecoUser) { return this.datasource.upsert(deviceId, user); }
  list(filters: { deviceId?: string; limit: number }) { return this.datasource.list(filters); }
}

export class DeviceUserPhotoRepositoryImpl implements DeviceUserPhotoRepository {
  constructor(private readonly datasource: DeviceUserPhotoDatasource) {}
  upsert(deviceId: string, userId: string, imageData: Buffer) { return this.datasource.upsert(deviceId, userId, imageData); }
  findByUserId(deviceId: string, userId: string) { return this.datasource.findByUserId(deviceId, userId); }
}

export class UserProfileRepositoryImpl implements UserProfileRepository {
  constructor(private readonly datasource: UserProfileDatasource) {}
  update(id: string, input: UserProfilePatch) { return this.datasource.update(id, input); }
}
