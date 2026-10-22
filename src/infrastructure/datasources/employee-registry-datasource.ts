import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../database/database.js';
import type { EmployeeRegistryDatasource } from '../../domain/datasources/employee-registry-datasource.js';
import type { ClockBinding, EmployeeCreation, EmployeeRegistrySession, RegistryEmployee } from '../../domain/repositories/employee-registry-repository.js';
import { ConfigurationError } from '../../domain/errors/app-error.js';
import { PrismaEmployeeDatasource } from './employee-datasource.js';
import { EmployeeLifecycle } from './employee-lifecycle.js';
import { PrismaEmployeeSchedulingDatasource, scheduleVersionColumns } from './employee-scheduling-datasource.js';
import { validateEmployeeScheduling } from '../../domain/entities/employee-scheduling.js';

const clockFields = 'u.id, u.employee_id AS "employeeId", u.device_id AS "deviceId", d.branch_id AS "branchId", u.binding_status AS "bindingStatus"';

class PrismaEmployeeRegistrySession implements EmployeeRegistrySession {
  constructor(private readonly database: Queryable) {}

  async branchTimeZone(id: string): Promise<string | undefined> {
    return (await this.database.prisma.branches.findUnique({ where: { id }, select: { time_zone: true } }))?.time_zone;
  }

  async create(input: EmployeeCreation, name: string, hireDate: string): Promise<string> {
    const id = randomUUID();
    await this.database.prisma.employees.create({ data: {
      id, name, first_name: input.firstName, last_name: input.lastName, rfc: input.rfc, imss: input.socialSecurityNumber,
      branch_id: input.branchId, position: input.position, hire_date: new Date(`${hireDate}T00:00:00Z`), original_name: name, name_split_method: 'manual',
    } });
    await this.database.prisma.branch_assignments.create({ data: {
      id: randomUUID(), employee_id: id, branch_id: input.branchId, effective_from: new Date('1900-01-01T00:00:00Z'),
    } });
    await new EmployeeLifecycle(this.database).recordInitial(id);
    if (input.scheduling) {
      const scheduling = new PrismaEmployeeSchedulingDatasource(this.database);
      const context = await scheduling.context(id, input.scheduling.effectiveFrom);
      validateEmployeeScheduling(input.scheduling, context.baseSchedule);
      await scheduling.append(id, input.scheduling);
    }
    return id;
  }

  async lockEmployee(id: string): Promise<RegistryEmployee> {
    const employee = (await this.database.query<RegistryEmployee>('SELECT id, branch_id AS "branchId", identification_status AS "identificationStatus", first_name AS "firstName" FROM employees WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!employee) throw new ConfigurationError('Empleado no encontrado.');
    return employee;
  }

  async updateProfile(id: string, fields: Record<string, string | null>): Promise<void> {
    await new PrismaEmployeeDatasource(this.database).update(id, fields);
  }

  async confirm(id: string): Promise<void> {
    await this.database.prisma.employees.update({ where: { id }, data: { identification_status: 'confirmed', updated_at: new Date() } });
  }

  async listClocks(employeeId: string): Promise<ClockBinding[]> {
    return (await this.database.query<ClockBinding>(`SELECT ${clockFields} FROM device_users u JOIN devices d ON d.id = u.device_id
      WHERE u.employee_id = $1 ORDER BY (u.binding_status = 'active') DESC, u.synced_at DESC FOR UPDATE OF u`, [employeeId])).rows;
  }

  async currentClock(employeeId: string): Promise<ClockBinding | undefined> {
    return (await this.database.query<ClockBinding>(`SELECT ${clockFields} FROM device_users u JOIN devices d ON d.id = u.device_id
      WHERE u.employee_id = $1 AND u.binding_status = 'active' FOR UPDATE OF u`, [employeeId])).rows[0];
  }

  async findClock(id: string): Promise<ClockBinding | undefined> {
    return (await this.database.query<ClockBinding>(`SELECT ${clockFields} FROM device_users u JOIN devices d ON d.id = u.device_id WHERE u.id = $1 FOR UPDATE OF u`, [id])).rows[0];
  }

  async archiveAndMerge(sourceId: string, targetId: string): Promise<void> {
    await this.database.query(`INSERT INTO employee_merge_events (id, source_employee_id, target_employee_id, original_data)
      SELECT $1,$2,$3,jsonb_build_object('source', to_jsonb(s), 'targetBefore', to_jsonb(t),
        'clockRecords', (SELECT jsonb_agg(to_jsonb(u)) FROM device_users u WHERE u.employee_id = s.id),
        'branchAssignments', (SELECT jsonb_agg(to_jsonb(a)) FROM branch_assignments a WHERE a.employee_id = s.id),
        'scheduleAssignments', (SELECT jsonb_agg(to_jsonb(a)) FROM schedule_assignments a WHERE a.employee_id = s.id),
        'scheduleVersions', (SELECT jsonb_agg(to_jsonb(v)) FROM employee_schedule_versions v WHERE v.employee_id = s.id))
      FROM employees s CROSS JOIN employees t WHERE s.id = $2 AND t.id = $3`, [randomUUID(), sourceId, targetId]);
    await this.database.query(`UPDATE employees target SET rfc = COALESCE(target.rfc, source.rfc), imss = COALESCE(target.imss, source.imss),
      branch_id = COALESCE(target.branch_id, source.branch_id), position = COALESCE(target.position, source.position), updated_at = NOW()
      FROM employees source WHERE target.id = $1 AND source.id = $2`, [targetId, sourceId]);
    for (const [table, column] of [['branch_assignments', 'branch_id'], ['schedule_assignments', 'schedule_id']]) {
      await this.database.query(`INSERT INTO ${table} (id, employee_id, ${column}, effective_from)
        SELECT gen_random_uuid(), $2, ${column}, effective_from FROM ${table} WHERE employee_id = $1
        AND NOT EXISTS (SELECT 1 FROM ${table} WHERE employee_id = $2)
        ON CONFLICT (employee_id, effective_from) DO NOTHING`, [sourceId, targetId]);
    }
    await this.database.query(`INSERT INTO employee_schedule_versions
      (id,employee_id,effective_from,work_hours,meal,recognition_margin_minutes,meal_mode,recognition_margin_inherited,source)
      SELECT gen_random_uuid(),$2,v.effective_from,v.work_hours,v.meal,v.recognition_margin_minutes,v.meal_mode,v.recognition_margin_inherited,'identity_merge'
      FROM employee_schedule_versions v WHERE v.employee_id=$1
        AND NOT EXISTS (SELECT 1 FROM employee_schedule_versions WHERE employee_id=$2)`, [sourceId, targetId]);
    await this.database.prisma.device_users.updateMany({ where: { employee_id: sourceId }, data: { binding_status: 'historical' } });
    await this.database.prisma.device_users.updateMany({ where: { employee_id: sourceId }, data: { employee_id: targetId } });
  }

  async assignClock(employeeId: string, clockId: string, previousId: string | undefined, reason: 'assignment' | 'identification'): Promise<void> {
    await this.database.prisma.device_users.updateMany({ where: { employee_id: employeeId }, data: { binding_status: 'historical' } });
    await this.database.prisma.device_users.update({ where: { id: clockId }, data: { binding_status: 'active' } });
    if (previousId !== clockId || reason === 'identification') {
      await this.database.prisma.employee_clock_events.create({ data: {
        id: randomUUID(), employee_id: employeeId, device_user_id: clockId, previous_device_user_id: previousId, reason,
      } });
    }
  }

  async finishMerge(sourceId: string, targetId: string): Promise<void> {
    await this.database.prisma.employees.update({ where: { id: sourceId }, data: { identification_status: 'merged', merged_into_id: targetId, updated_at: new Date() } });
  }
}

export class PrismaEmployeeRegistryDatasource implements EmployeeRegistryDatasource {
  constructor(private readonly database: Database, private readonly refreshBranches: (client: Queryable) => Promise<void>) {}

  transaction<T>(operation: (session: EmployeeRegistrySession) => Promise<T>): Promise<T> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-identification'))::text");
      await this.refreshBranches(client);
      return operation(new PrismaEmployeeRegistrySession(client));
    });
  }

  async clockEmployeeId(id: string): Promise<string | undefined> {
    return (await this.database.prisma.device_users.findUnique({ where: { id }, select: { employee_id: true } }))?.employee_id;
  }

  async history(employeeId: string) {
    const snapshots = (await this.database.query(`SELECT id, source_type AS "sourceType", source_id AS "sourceId", record, created_at AS "createdAt"
      FROM employee_unification_snapshots WHERE (source_type = 'employee' AND source_id = $1)
      OR (source_type = 'device_user' AND source_id IN (SELECT id FROM device_users WHERE employee_id = $1)) ORDER BY created_at`, [employeeId])).rows;
    const merges = (await this.database.query(`SELECT id, source_employee_id AS "sourceEmployeeId", target_employee_id AS "targetEmployeeId",
      original_data AS "originalData", created_at AS "createdAt" FROM employee_merge_events WHERE source_employee_id = $1 OR target_employee_id = $1 ORDER BY created_at DESC`, [employeeId])).rows;
    const clockEvents = (await this.database.query(`SELECT id, device_user_id AS "clockRecordId", previous_device_user_id AS "previousClockRecordId", reason,
      created_at AS "createdAt" FROM employee_clock_events WHERE employee_id = $1
      OR employee_id IN (SELECT source_employee_id FROM employee_merge_events WHERE target_employee_id = $1) ORDER BY created_at DESC`, [employeeId])).rows;
    const statusEvents = (await this.database.query(`SELECT id, event_type AS "eventType", previous_is_active AS "previousIsActive", is_active AS "isActive",
      local_date::text AS "localDate", time_zone AS "timeZone", previous_termination_date::text AS "previousTerminationDate",
      termination_date::text AS "terminationDate", original_data AS "originalData", created_at AS "createdAt"
      FROM employee_status_events WHERE employee_id = $1 OR employee_id IN (
        SELECT source_employee_id FROM employee_merge_events WHERE target_employee_id = $1) ORDER BY created_at DESC`, [employeeId])).rows;
    const scheduleEvents = (await this.database.query(`SELECT ${scheduleVersionColumns} FROM employee_schedule_versions
      WHERE employee_id=$1 OR employee_id IN (SELECT source_employee_id FROM employee_merge_events WHERE target_employee_id=$1)
      ORDER BY created_at DESC,id DESC`, [employeeId])).rows;
    return { snapshots, merges, clockEvents, statusEvents, scheduleEvents };
  }
}
