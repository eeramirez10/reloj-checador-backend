import type { BranchConfigurationDatasource } from '../../domain/datasources/branch-configuration-datasource.js';
import type { BranchConfigurationRepository } from '../../domain/repositories/branch-configuration-repository.js';
import type { BranchConfigurationInput } from '../../domain/entities/branch-configuration.js';

export class BranchConfigurationRepositoryImpl implements BranchConfigurationRepository {
  constructor(private readonly datasource: BranchConfigurationDatasource) {}
  contexts() { return this.datasource.contexts(); }
  context(branchId: string) { return this.datasource.context(branchId); }
  save(branchId: string, input: BranchConfigurationInput) { return this.datasource.save(branchId, input); }
  remove(branchId: string, versionId: string, expectedVersionId?: string | null) { return this.datasource.remove(branchId, versionId, expectedVersionId); }
}
