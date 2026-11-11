import type { Company,CompanyInput } from '../entities/company.js';
export interface CompanyRepository {
  list(): Promise<Company[]>;
  save(input: CompanyInput,id?: string,expectedVersion?: number): Promise<Company>;
}
