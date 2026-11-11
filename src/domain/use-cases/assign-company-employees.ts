import type { AuthPrincipal } from '../entities/auth.js';
import type { CompanyEmployeeAssignment,CompanyEmployeeRepository } from '../repositories/company-employee-repository.js';
import { AppError } from '../errors/app-error.js';
export class AssignCompanyEmployees {
  constructor(private readonly repository:CompanyEmployeeRepository) {}
  execute(companyId:string,assignments:CompanyEmployeeAssignment[],expectedVersion:number,actor:AuthPrincipal) {
    if(!['admin','hr'].includes(actor.role)) throw new AppError('Solo RH y administrador pueden asignar empresas.','FORBIDDEN');
    return this.repository.assign(companyId,assignments,expectedVersion,actor);
  }
}
