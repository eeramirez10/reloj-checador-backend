import type { EvaluationDatasource } from '../../domain/datasources/evaluation-datasource.js';
import type { EvaluationRepository, EvaluationSession } from '../../domain/repositories/evaluation-repository.js';
import type { ReportFilters } from '../../domain/dtos/filters.js';

export class EvaluationRepositoryImpl implements EvaluationRepository {
  constructor(private readonly datasource: EvaluationDatasource) {}
  transaction<T>(operation: (session: EvaluationSession) => Promise<T>) { return this.datasource.transaction(operation); }
  report(filters: ReportFilters) { return this.datasource.report(filters); }
  deductions(filters: ReportFilters) { return this.datasource.deductions(filters); }
}
