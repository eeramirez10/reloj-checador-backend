import type { Employee, EmployeeCatalogRecord } from '../entities/employee.js';
import type { EmployeeFilters } from '../dtos/filters.js';

export interface EmployeeRepository {
  findById(id: string): Promise<Employee | undefined>;
  update(id: string, fields: Record<string, string | null>, isActive?: boolean): Promise<boolean>;
  upsert(employee: EmployeeCatalogRecord): Promise<void>;
  list(filters: EmployeeFilters): Promise<Employee[]>;
}
