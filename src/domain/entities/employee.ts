import type { EmployeeScheduleSettings } from './employee-scheduling.js';

export type EmploymentStatus = 'active' | 'inactive' | 'pending';
export interface EmployeeCatalogRecord {
  employeeNumber: string; normalizedEmployeeNumber: string; name: string; position?: string; rfc?: string; imss?: string;
  managementCode?: string; sectionCode?: string; companyCode?: string; branchCode?: string; scheduleTypeCode?: string;
  hireDate?: string; terminationDate?: string;
}
export interface EmployeeClockRecord {
  uid?: number;
  roleObservedAt?: string | null;
  id: string; deviceId: string; userId: string; name?: string; deviceName: string;
  branchId?: string; bindingStatus: 'active' | 'historical'; hasPhoto: boolean;
  syncedAt: string; cardNumber?: string; role?: number; originalProfile: Record<string, unknown>;
}
export interface Employee extends Omit<EmployeeCatalogRecord, 'employeeNumber' | 'normalizedEmployeeNumber'> {
  id: string; employeeNumber?: string; normalizedEmployeeNumber?: string; employmentStatus: EmploymentStatus;
  createdAt: Date; updatedAt: Date; branchId?: string; branchName?: string; firstName?: string; lastName?: string;
  identificationStatus: 'confirmed' | 'pending' | 'merged'; mergedIntoId?: string; clockRecords: EmployeeClockRecord[];
  isActive: boolean; originalName?: string; nameSplitMethod?: string;
  companyId?: string | null; companyName?: string | null;
  hasAttendance?: boolean;
  scheduling?: EmployeeScheduleSettings & { versionId: string; effectiveFrom: string };
}
export function normalizeEmployeeNumber(employeeNumber: string): string {
  return employeeNumber.replace(/^0+/, '') || '0';
}
