import { randomUUID } from 'node:crypto';
import type { LeaveDetails, LeaveEvent, LeaveFilters, LeaveInput, LeaveProfile, LeaveProfileInput, LeaveRequest, LeaveStatus, VacationMovement } from '../../domain/entities/leave.js';
import type { LeaveContext, LeaveRepository, LeaveSession } from '../../domain/repositories/leave-repository.js';
import { NotFoundError } from '../../domain/errors/not-found-error.js';
import { ConflictError } from '../../domain/errors/app-error.js';
import type { Database, Queryable } from '../database/database.js';
import { PrismaEmployeeDatasource } from '../datasources/employee-datasource.js';
import { loadEmployeeAttendanceHistories } from '../datasources/employee-attendance-datasource.js';
import { leaveRequestColumns } from '../datasources/leave-columns.js';
import { normalizePhoneNumber } from '../integrations/twilio/phone-number.js';
import type { CountryCode } from 'libphonenumber-js';
import { accessContext, branchScopeSql } from '../security/access-context.js';
import type { EmailSettings } from '../config/email.js';
import { enqueueEmail } from './email-outbox.js';
import type { AuthAccount,AuthPrincipal } from '../../domain/entities/auth.js';

export class PrismaLeaveSession implements LeaveSession {
  constructor(private readonly client: Queryable, private readonly recalculate: () => Promise<void>, private readonly country: CountryCode = 'MX', private readonly email?: EmailSettings) {}

  async decisionAccount(id: string) {
    return (await this.client.query<Pick<AuthAccount,'role' | 'employeeId' | 'isActive' | 'version'>>(`SELECT role,employee_id AS "employeeId",is_active AS "isActive",version FROM auth_accounts WHERE id=$1 FOR SHARE`,[id])).rows[0];
  }

  async cancellationBranches(id:string) {
    return (await this.client.query<{branch_id:string|null}>(`SELECT branch_id FROM leave_requests WHERE id=$1
      UNION SELECT e.branch_id FROM employees e JOIN leave_requests r ON r.employee_id=e.id WHERE r.id=$1
      UNION SELECT (day->>'branchId')::uuid FROM leave_requests r CROSS JOIN LATERAL jsonb_array_elements(r.details->'days') day WHERE r.id=$1`,[id])).rows.map(row=>row.branch_id);
  }

  async context(employeeId: string, from: string, to: string): Promise<LeaveContext> {
    const employee = await new PrismaEmployeeDatasource(this.client).findById(employeeId);
    if (!employee) throw new NotFoundError('Empleado no encontrado.');
    return { employee, profile: await this.profile(employeeId), history: (await loadEmployeeAttendanceHistories(this.client, [employeeId], { from, to })).get(employeeId)! };
  }

  async profile(employeeId: string): Promise<LeaveProfile> {
    const row = (await this.client.query<LeaveProfile>(`SELECT employee_id AS "employeeId", manager_id AS "managerId",
      (SELECT name FROM employees WHERE id=manager_id) AS "managerName", whatsapp_phone AS "whatsappPhone",
      vacation_balance AS "vacationBalance", version FROM employee_leave_profiles WHERE employee_id=$1`, [employeeId])).rows[0];
    return row ?? { employeeId, managerId: null, managerName: null, whatsappPhone: null, vacationBalance: 0, version: 0 };
  }

  async saveProfile(employeeId: string, input: LeaveProfileInput) {
    const phone = input.whatsappPhone === null ? null : normalizePhoneNumber(input.whatsappPhone,this.country);
    await this.client.query(`INSERT INTO employee_leave_profiles (employee_id,manager_id,whatsapp_phone,vacation_balance)
      VALUES ($1,$2,$3,$4) ON CONFLICT (employee_id) DO UPDATE SET manager_id=$2,whatsapp_phone=$3,version=employee_leave_profiles.version+1,updated_at=NOW()`,
    [employeeId, input.managerId, phone, input.vacationBalance]);
    return this.profile(employeeId);
  }

  async vacationMovement(employeeId: string, days: number, kind: VacationMovement['kind'], reason: string, requestId?: string) {
    const result = (await this.client.query<{ balance: number }>(`UPDATE employee_leave_profiles SET vacation_balance=vacation_balance+$2,
      version=version+1,updated_at=NOW() WHERE employee_id=$1 AND vacation_balance+$2>=0 RETURNING vacation_balance AS balance`, [employeeId, days])).rows[0];
    if (!result) throw new ConflictError('El saldo de vacaciones es insuficiente.');
    await this.client.query(`INSERT INTO vacation_movements (id,employee_id,request_id,kind,days,balance_after,reason,actor_account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), employeeId, requestId ?? null, kind, days, result.balance, reason, accessContext.current()?.id ?? null]);
  }

  async find(id: string) {
    const row = (await this.client.query<LeaveRequest>(`SELECT ${leaveRequestColumns} FROM leave_requests WHERE id=$1`, [id])).rows[0];
    if (!row) throw new NotFoundError('Permiso no encontrado.');
    return row;
  }
  async overlapping(employeeId: string, from: string, to: string) {
    return (await this.client.query<LeaveRequest>(`SELECT ${leaveRequestColumns} FROM leave_requests WHERE employee_id=$1
      AND status IN ('pending','approved') AND from_date <= $3::date AND to_date >= $2::date`, [employeeId, from, to])).rows;
  }
  async findBySourceKey(key: string) {
    return (await this.client.query<LeaveRequest>(`SELECT ${leaveRequestColumns} FROM leave_requests WHERE source_key=$1`, [key])).rows[0] ?? null;
  }
  async create(input: LeaveInput, managerId: string, branchId: string, details: LeaveDetails, sourceKey: string) {
    const id = randomUUID();
    await this.client.query(`INSERT INTO leave_requests (id,employee_id,manager_id,branch_id,kind,from_date,to_date,authorized_time,paid,use_vacation,reason,details,source_key,client_name,full_day,replaces_request_id)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)`,
    [id, input.employeeId, managerId, branchId, input.kind, input.from, input.to, input.authorizedTime, input.paid, input.useVacation, input.reason, JSON.stringify(details), sourceKey,input.clientName??null,input.fullDay??true,input.replacesRequestId??null]);
    return this.find(id);
  }
  async resolve(id: string, status: LeaveStatus, actorId: string|null) {
    await this.client.query('UPDATE leave_requests SET status=$2,resolved_by=$3,resolved_at=NOW(),version=version+1 WHERE id=$1', [id, status, actorId]);
    return this.find(id);
  }
  async event(request: LeaveRequest, kind: LeaveEvent['kind'], comments: string, actorId?: string|null,previousStatus?:LeaveStatus,actorAccount?:AuthPrincipal) {
    const recipientId = kind === 'created' ? request.managerId : request.employeeId;
    const recipient = await this.profile(recipientId);
    const eventId = randomUUID();
    const account=actorAccount??accessContext.current();
    await this.client.query(`INSERT INTO leave_request_events (id,request_id,kind,actor_employee_id,comments,recipient_employee_id,recipient_phone,actor_account_id,previous_status,actor_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [eventId, request.id, kind, actorId ?? null, comments, recipientId, recipient.whatsappPhone, account?.id ?? null,previousStatus??null,account?.role??null]);
    if (this.email?.encryptionKey) {
      const contact = (await this.client.query<{ email: string | null }>('SELECT email FROM employee_contacts WHERE employee_id=$1',[recipientId])).rows[0];
      if (contact?.email) {
        const labels = { created: 'Nueva solicitud de permiso',approved: 'Permiso aprobado',rejected: 'Permiso rechazado',cancelled: 'Permiso cancelado' };
        const url = new URL('my/permissions',this.email.publicUrl.replace(/\/?$/,'/'));
        url.searchParams.set('requestId',request.id);
        await enqueueEmail(this.client,this.email,{ employeeId: recipientId,recipient: contact.email,kind: 'leave',eventId,expiresAt: new Date(Date.now()+7*24*60*60*1000),
          content: { subject: labels[kind],text: `${labels[kind]}\n\nEmpleado: ${request.details.employeeName}\nPeriodo: ${request.from} al ${request.to}\n${request.clientName?`Cliente: ${request.clientName}\n`:''}${comments ? `Comentarios: ${comments}\n` : ''}\nRevisa la solicitud e inicia sesión en el sistema:\n${url}\n\nRecursos Humanos` } });
      }
    }
  }
  recalculateAttendance() { return this.recalculate(); }
}

export class PrismaLeaveRepository implements LeaveRepository {
  constructor(private readonly database: Database, private readonly recalculate: (client: Queryable) => Promise<void>, private readonly country: CountryCode = 'MX', private readonly email?: EmailSettings) {}

  transaction<T>(operation: (session: LeaveSession) => Promise<T>): Promise<T> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('attendance-evaluation'))::text");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-leave'))::text");
      return operation(new PrismaLeaveSession(client, () => this.recalculate(client),this.country,this.email));
    });
  }
  async list(filters: LeaveFilters) {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const account = accessContext.current();
      const management = account?.role === 'employee' ? 'FALSE' : `((${branchScopeSql('branch_id')}) AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(details->'days') day WHERE NOT (${branchScopeSql("(day->>'branchId')::uuid")}))
        AND employee_id IN (SELECT id FROM employees WHERE ${branchScopeSql('branch_id')}))`;
      const relationship = '(employee_id=$8::uuid OR manager_id=$8::uuid)';
      const visibility = filters.scope === 'own' ? 'employee_id=$8::uuid' : filters.scope === 'assigned' ? 'manager_id=$8::uuid AND employee_id<>$8::uuid' : `(${management} OR ${relationship})`;
      const condition = `${visibility}
        AND from_date <= $2::date AND to_date >= $1::date AND ($3::uuid IS NULL OR branch_id=$3)
        AND ($4::uuid IS NULL OR employee_id=$4) AND ($5::uuid IS NULL OR manager_id=$5)
        AND ($6::text IS NULL OR status=$6) AND ($7::text IS NULL OR kind=$7)`;
      const parameters = [filters.from, filters.to, filters.branchId ?? null, filters.employeeId ?? null, filters.managerId ?? null, filters.status ?? null, filters.kind ?? null, account?.employeeId ?? null];
      const total = (await client.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM leave_requests WHERE ${condition}`, parameters)).rows[0].count;
      const page = Math.min(filters.page, Math.max(1, Math.ceil(total / filters.limit)));
      const requests = (await client.query<LeaveRequest>(`SELECT ${leaveRequestColumns} FROM leave_requests WHERE ${condition}
        ORDER BY created_at DESC,id DESC LIMIT $9 OFFSET $10`, [...parameters, filters.limit, (page - 1) * filters.limit])).rows;
      return { requests, total, page, limit: filters.limit };
    });
  }
  async detail(id: string) {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const request = await new PrismaLeaveSession(client, async () => {}).find(id);
      const events = (await client.query<LeaveEvent>(`SELECT e.id,e.kind,actor_employee_id AS "actorEmployeeId",actor_account_id AS "actorAccountId",
        (SELECT name FROM auth_accounts WHERE id=actor_account_id) AS "actorAccountName",(SELECT name FROM employees WHERE id=actor_employee_id) AS "actorEmployeeName",e.actor_role AS "actorRole",e.previous_status AS "previousStatus",comments,
        recipient_employee_id AS "recipientEmployeeId",recipient_phone AS "recipientPhone",notification_status AS "notificationStatus",e.created_at AS "createdAt",
        m.state AS "emailStatus",m.recipient AS "recipientEmail" FROM leave_request_events e LEFT JOIN email_outbox m ON m.event_id=e.id WHERE request_id=$1 ORDER BY e.created_at,e.id`, [id])).rows;
      return { request, events };
    });
  }
  async profile(employeeId: string) {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      if (!await new PrismaEmployeeDatasource(client).findById(employeeId)) throw new NotFoundError('Empleado no encontrado.');
      const profile = await new PrismaLeaveSession(client, async () => {}).profile(employeeId);
      const movements = (await client.query<VacationMovement>(`SELECT id,request_id AS "requestId",kind,days,balance_after AS "balanceAfter",reason,created_at AS "createdAt"
        FROM vacation_movements WHERE employee_id=$1 ORDER BY created_at DESC,id DESC`, [employeeId])).rows;
      return { ...profile, movements };
    });
  }
}
