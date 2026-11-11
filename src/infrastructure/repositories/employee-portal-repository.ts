import type { EmployeePortalRepository, EmployeeAccessView, PortalProfile } from '../../domain/repositories/employee-portal-repository.js';
import type { ContactInput } from '../../domain/entities/employee-contact.js';
import { AppError } from '../../domain/errors/app-error.js';
import { randomUUID } from 'node:crypto';
import type { Database } from '../database/database.js';
import { PrismaEmployeeContactRepository } from './employee-contact-repository.js';
import type { CountryCode } from 'libphonenumber-js';

export class PrismaEmployeePortalRepository implements EmployeePortalRepository {
  constructor(private readonly database: Database, private readonly country: CountryCode = 'MX') {}
  async profile(employeeId: string): Promise<PortalProfile> {
    const row = (await this.database.query<Omit<PortalProfile,'contact'>>(`SELECT e.id AS "employeeId",e.name,e.employee_number AS "employeeNumber",
      b.name AS "branchName",e.company_id AS "companyId",(SELECT name FROM companies WHERE id=e.company_id) AS "companyName",COALESCE(b.time_zone,'America/Mexico_City') AS "timeZone",m.name AS "managerName",
      COALESCE(p.vacation_balance,0) AS "vacationBalance",(EXISTS(SELECT 1 FROM employee_leave_profiles r WHERE r.manager_id=e.id) OR EXISTS(SELECT 1 FROM leave_requests r WHERE r.manager_id=e.id)) AS "hasReports"
      FROM employees e LEFT JOIN branches b ON b.id=e.branch_id LEFT JOIN employee_leave_profiles p ON p.employee_id=e.id
      LEFT JOIN employees m ON m.id=p.manager_id WHERE e.id=$1 AND e.is_active AND e.identification_status='confirmed'`, [employeeId])).rows[0];
    if (!row) throw new AppError('Tu empleado no está activo o no está vinculado.', 'FORBIDDEN');
    return { ...row,contact: await new PrismaEmployeeContactRepository(this.database,this.country).get(employeeId) };
  }
  saveContact(employeeId: string, input: ContactInput, accountId: string) {
    return this.database.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-leave'))::text");
      const saved = await new PrismaEmployeeContactRepository(client,this.country).save(employeeId,input);
      await client.query(`INSERT INTO auth_audit_events(id,account_id,action,target_id,metadata) VALUES($1,$2,'contact_updated',$3,'{}')`, [randomUUID(),accountId,employeeId]);
      return saved;
    });
  }
  async managers() {
    return (await this.database.query<{ id: string; name: string; branchName: string | null }>(`SELECT e.id,e.name,b.name AS "branchName" FROM employees e
      LEFT JOIN branches b ON b.id=e.branch_id WHERE e.is_active AND e.identification_status='confirmed' ORDER BY e.name,e.id`)).rows;
  }
  async bloodTypes() { return (await this.database.query<{ code: string }>('SELECT code FROM blood_types ORDER BY code')).rows.map(row => row.code); }
  async access(employeeId: string): Promise<EmployeeAccessView> {
    const account = (await this.database.query<NonNullable<EmployeeAccessView['account']>>(`SELECT id,username,role,is_active AS "isActive",must_change_password AS "mustChangePassword"
      FROM auth_accounts WHERE employee_id=$1`, [employeeId])).rows[0] ?? null;
    const messages = (await this.database.query<EmployeeAccessView['messages'][number]>(`SELECT id,state,recipient,attempts,error_code AS "errorCode",created_at AS "createdAt"
      FROM email_outbox WHERE employee_id=$1 AND kind='welcome' ORDER BY created_at DESC LIMIT 10`, [employeeId])).rows;
    return { account,messages };
  }
}
