import type { EmployeeNameDatasource } from '../../domain/datasources/employee-name-datasource.js';
import type { EmployeeNameRepository, EmployeeNameSession } from '../../domain/repositories/employee-name-repository.js';

export class EmployeeNameRepositoryImpl implements EmployeeNameRepository {
  constructor(private readonly datasource: EmployeeNameDatasource) {}
  transaction<T>(operation: (session: EmployeeNameSession) => Promise<T>) { return this.datasource.transaction(operation); }
}
