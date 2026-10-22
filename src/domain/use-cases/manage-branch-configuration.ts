import { configurationView, type BranchConfigurationInput } from '../entities/branch-configuration.js';
import type { BranchConfigurationRepository } from '../repositories/branch-configuration-repository.js';
import type { AttendanceEvaluationService } from './evaluate-attendance.js';

export class BranchConfigurationService {
  constructor(private readonly repository: BranchConfigurationRepository, private readonly evaluation: Pick<AttendanceEvaluationService, 'recalculate'>) {}
  async list() { return (await this.repository.contexts()).map(configurationView); }
  async find(branchId: string) { return configurationView(await this.repository.context(branchId)); }
  async save(branchId: string, input: BranchConfigurationInput) {
    await this.repository.save(branchId, input);
    await this.evaluation.recalculate();
    return this.find(branchId);
  }
  async remove(branchId: string, versionId: string, expectedVersionId?: string | null) {
    await this.repository.remove(branchId, versionId, expectedVersionId);
    await this.evaluation.recalculate();
    return this.find(branchId);
  }
}
