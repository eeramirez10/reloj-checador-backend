import type { EmployeeRegistryDatasource } from '../../domain/datasources/employee-registry-datasource.js';
import type { EmployeeRegistryRepository, EmployeeRegistrySession } from '../../domain/repositories/employee-registry-repository.js';

export class EmployeeRegistryRepositoryImpl implements EmployeeRegistryRepository {
  constructor(private readonly datasource: EmployeeRegistryDatasource) {}
  transaction<T>(operation: (session: EmployeeRegistrySession) => Promise<T>) { return this.datasource.transaction(operation); }
  clockEmployeeId(id: string) { return this.datasource.clockEmployeeId(id); }
  history(employeeId: string) { return this.datasource.history(employeeId); }
}
