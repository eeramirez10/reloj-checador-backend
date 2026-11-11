import type { AuthPrincipal } from '../entities/auth.js';
export interface CompanyEmployeeFilters {
  branchId?:string;companyId?:string;search?:string;sortBy:'name'|'branch'|'company';sortOrder:'asc'|'desc';page:number;limit:number;
}
export interface CompanyEmployee {
  id:string;name:string;branchId:string|null;branchName:string|null;companyId:string|null;companyName:string|null;isActive:boolean;
}
export interface CompanyEmployeePage {employees:CompanyEmployee[];total:number;page:number;totalPages:number}
export interface CompanyEmployeeAssignment {employeeId:string;expectedCompanyId:string|null}
export interface CompanyEmployeeRepository {
  candidates(companyId:string,filters:CompanyEmployeeFilters,actor:AuthPrincipal):Promise<CompanyEmployeePage>;
  assign(companyId:string,assignments:CompanyEmployeeAssignment[],expectedVersion:number,actor:AuthPrincipal):Promise<{assigned:number}>;
}
