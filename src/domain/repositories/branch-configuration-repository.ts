import type { BranchConfigurationContext, BranchConfigurationInput } from '../entities/branch-configuration.js';

export interface BranchConfigurationRepository {
  contexts(): Promise<BranchConfigurationContext[]>;
  context(branchId: string): Promise<BranchConfigurationContext>;
  save(branchId: string, input: BranchConfigurationInput): Promise<void>;
  remove(branchId: string, versionId: string, expectedVersionId?: string | null): Promise<void>;
}
