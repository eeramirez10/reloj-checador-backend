import { randomUUID } from 'node:crypto';
import type { CompanyEmployeeRepository,CompanyEmployee,CompanyEmployeeFilters,CompanyEmployeeAssignment } from '../../domain/repositories/company-employee-repository.js';
import { canAccessBranch,type AuthPrincipal } from '../../domain/entities/auth.js';
import { AppError,ConfigurationError,ConflictError } from '../../domain/errors/app-error.js';
import type { Database } from '../database/database.js';
import { companyFilterSql } from '../datasources/company-filter.js';

export class PrismaCompanyEmployeeRepository implements CompanyEmployeeRepository {
  constructor(private readonly database:Database) {}
  candidates(companyId:string,filters:CompanyEmployeeFilters,actor:AuthPrincipal) {
    if(!['admin','hr'].includes(actor.role)) throw new AppError('No tienes permiso para asignar empleados.','FORBIDDEN');
    return this.database.transaction(async client=>{
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      if(!(await client.query('SELECT id FROM companies WHERE id=$1',[companyId])).rows.length) throw new ConfigurationError('Empresa no encontrada.');
      const pattern=filters.search?.trim()?`%${filters.search.trim().replace(/[\\%_]/g,'\\$&')}%`:null;
      const condition=`e.discarded_at IS NULL AND e.identification_status<>'merged' AND ($1::boolean OR e.branch_id=ANY($2::uuid[]))
        AND ($3::uuid IS NULL OR e.branch_id=$3) AND ${companyFilterSql('e.company_id',4)}
        AND ($5::text IS NULL OR e.name ILIKE $5 OR EXISTS(SELECT 1 FROM device_users u JOIN devices d ON d.id=u.device_id
          WHERE u.employee_id=e.id AND ($1::boolean OR d.branch_id=ANY($2::uuid[])) AND u.device_user_id ILIKE $5))`;
      const parameters=[actor.role==='admin',actor.branchIds,filters.branchId??null,filters.companyId??null,pattern];
      const total=(await client.query<{count:number}>(`SELECT COUNT(*)::int AS count FROM employees e WHERE ${condition}`,parameters)).rows[0].count;
      const totalPages=Math.ceil(total/filters.limit);const page=Math.min(filters.page,Math.max(1,totalPages));
      const column={name:'e.name',branch:'b.name',company:'c.name'}[filters.sortBy];const direction=filters.sortOrder==='desc'?'DESC':'ASC';
      const employees=(await client.query<CompanyEmployee>(`SELECT e.id,e.name,e.branch_id AS "branchId",b.name AS "branchName",e.company_id AS "companyId",c.name AS "companyName",e.is_active AS "isActive"
        FROM employees e LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN companies c ON c.id=e.company_id WHERE ${condition}
        ORDER BY ${column} ${direction} NULLS LAST,e.name,e.id LIMIT $6 OFFSET $7`,[...parameters,filters.limit,(page-1)*filters.limit])).rows;
      return {employees,total,page,totalPages};
    });
  }
  assign(companyId:string,assignments:CompanyEmployeeAssignment[],expectedVersion:number,actor:AuthPrincipal) {
    return this.database.transaction(async client=>{
      const account=(await client.query<{role:string;is_active:boolean;version:number}>('SELECT role,is_active,version FROM auth_accounts WHERE id=$1 FOR SHARE',[actor.id])).rows[0];
      if(!account?.is_active || !['admin','hr'].includes(account.role) || account.role!==actor.role || account.version!==actor.version) throw new AppError('Tu cuenta cambió. Inicia sesión nuevamente.','FORBIDDEN');
      const company=(await client.query<{active:boolean;version:number}>('SELECT active,version FROM companies WHERE id=$1 FOR SHARE',[companyId])).rows[0];
      if(!company?.active) throw new ConfigurationError('Selecciona una empresa activa.');
      if(company.version!==expectedVersion) throw new ConflictError('La empresa cambió. Actualiza el catálogo antes de asignar.');
      const ids=assignments.map(item=>item.employeeId);
      if(!ids.length || new Set(ids).size!==ids.length) throw new ConfigurationError('Selecciona empleados sin repetir.');
      const employees=(await client.query<{id:string;branch_id:string|null;company_id:string|null}>(`SELECT id,branch_id,company_id FROM employees
        WHERE id=ANY($1::uuid[]) AND discarded_at IS NULL AND identification_status<>'merged' ORDER BY id FOR UPDATE`,[ids])).rows;
      if(employees.length!==ids.length || employees.some(person=>!canAccessBranch(actor,person.branch_id))) throw new AppError('Algún empleado ya no está disponible en tus sucursales.','FORBIDDEN');
      const expected=new Map(assignments.map(item=>[item.employeeId,item.expectedCompanyId]));
      if(employees.some(person=>person.company_id!==expected.get(person.id))) throw new ConflictError('La empresa de un empleado cambió. Actualiza la selección antes de guardar.');
      const changed=employees.filter(person=>person.company_id!==companyId);
      if(changed.length) {
        await client.query('UPDATE employees SET company_id=$2,updated_at=NOW() WHERE id=ANY($1::uuid[])',[changed.map(person=>person.id),companyId]);
        await client.query("INSERT INTO auth_audit_events(id,account_id,action,target_id,metadata) VALUES($1,$2,'company_employees_assigned',$3,$4::jsonb)",[randomUUID(),actor.id,companyId,JSON.stringify({employees:changed.map(person=>({employeeId:person.id,previousCompanyId:person.company_id}))})]);
      }
      return {assigned:changed.length};
    });
  }
}
