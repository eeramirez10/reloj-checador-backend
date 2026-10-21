import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db/database.js';
import { ConfigurationError } from '../organization/schemas.js';
import type { OrganizationRepository } from '../organization/organization-repository.js';
import { getUpdatedProfileName, type UserProfilePatch } from '../users/personal-profile.js';
import { EmployeeRepository } from './employee-repository.js';
import { EmployeeLifecycle } from './employee-lifecycle.js';
import { formatDateTimeInTimeZone } from '../attendance/attendance-summary.js';

type EmployeeRow = { id: string; branch_id: string | null; identification_status: string; first_name: string | null };
type ClockRow = { id: string; employee_id: string; device_id: string; branch_id: string | null; binding_status: string };
export type EmployeeCreation = UserProfilePatch & { branchId: string; position?: string | null };

function personalFields(input: UserProfilePatch): Record<string, string | null> {
  return Object.fromEntries(Object.entries({ firstName: input.firstName, lastName: input.lastName, rfc: input.rfc, imss: input.socialSecurityNumber })
    .filter(([, value]) => value !== undefined)) as Record<string, string | null>;
}

export class EmployeeRegistry {
  constructor(private readonly database: Database, private readonly organization: OrganizationRepository) {}

  async create(input: EmployeeCreation): Promise<string> {
    const name = getUpdatedProfileName({ firstName: null, lastName: null }, input);
    if (!name) throw new ConfigurationError('Completa Nombre(s) para crear al empleado.');
    return this.database.transaction(async (client) => {
      const id = randomUUID();
      const branch = (await client.query<{ time_zone: string }>('SELECT time_zone FROM branches WHERE id = $1', [input.branchId])).rows[0];
      if (!branch) throw new ConfigurationError('Sucursal no encontrada.');
      const hireDate = formatDateTimeInTimeZone(new Date(), branch.time_zone).slice(0, 10);
      await client.query(`INSERT INTO employees (id, name, first_name, last_name, rfc, imss, branch_id, position, hire_date, original_name, name_split_method)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$2,'manual')`, [id, name, input.firstName, input.lastName ?? null, input.rfc ?? null,
        input.socialSecurityNumber ?? null, input.branchId, input.position ?? null, hireDate]);
      await client.query(`INSERT INTO branch_assignments (id, employee_id, branch_id, effective_from) VALUES ($1,$2,$3,'1900-01-01')`, [randomUUID(), id, input.branchId]);
      await new EmployeeLifecycle(client).recordInitial(id);
      return id;
    });
  }

  async identify(id: string, input: UserProfilePatch & { targetEmployeeId?: string; useAsAssignedClock?: boolean }): Promise<string> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-identification'))");
      await this.organization.refreshCurrentBranches(client);
      const source = await this.lockEmployee(client, id);
      if (source.identification_status === 'merged') throw new ConfigurationError('Esta ficha ya fue asociada a otro empleado.');
      if (!input.targetEmployeeId || input.targetEmployeeId === id) {
        const fields = personalFields(input);
        if (Object.keys(fields).length) await new EmployeeRepository(client).update(id, fields);
        const updated = await this.lockEmployee(client, id);
        if (!updated.first_name) throw new ConfigurationError('Completa Nombre(s) antes de confirmar la identificación.');
        await client.query("UPDATE employees SET identification_status = 'confirmed', updated_at = NOW() WHERE id = $1", [id]);
        return id;
      }
      if (source.identification_status !== 'pending') throw new ConfigurationError('Solo las fichas pendientes pueden asociarse a un empleado existente.');
      if (Object.keys(personalFields(input)).length) throw new ConfigurationError('Guarda los datos personales en la ficha antes de asociarla.');
      const target = await this.lockEmployee(client, input.targetEmployeeId);
      if (target.identification_status !== 'confirmed') throw new ConfigurationError('Selecciona un empleado ya identificado.');
      if (source.branch_id && target.branch_id && source.branch_id !== target.branch_id) throw new ConfigurationError('El registro y el empleado deben pertenecer a la misma sucursal.');
      const clocks = (await client.query<ClockRow>(`SELECT u.id, u.employee_id, u.device_id, d.branch_id, u.binding_status
        FROM device_users u JOIN devices d ON d.id = u.device_id WHERE u.employee_id = $1
        ORDER BY (u.binding_status = 'active') DESC, u.synced_at DESC FOR UPDATE OF u`, [id])).rows;
      const currentClock = (await client.query<ClockRow>(`SELECT id, employee_id, device_id, branch_id, binding_status
        FROM device_users WHERE employee_id = $1 AND binding_status = 'active' FOR UPDATE`, [target.id])).rows[0];
      const sourceClock = clocks[0];
      if (sourceClock && (!currentClock || input.useAsAssignedClock) && (target.branch_id ?? source.branch_id) !== sourceClock.branch_id) {
        throw new ConfigurationError('El reloj actual debe pertenecer a la sucursal del empleado.');
      }
      if (currentClock && sourceClock && currentClock.device_id !== sourceClock.device_id && !input.useAsAssignedClock) {
        throw new ConfigurationError('El empleado ya tiene otro reloj asignado. Selecciona usar este registro como su reloj actual.');
      }
      await this.archiveMerge(client, source.id, target.id);
      await client.query(`UPDATE employees target SET
        rfc = COALESCE(target.rfc, source.rfc), imss = COALESCE(target.imss, source.imss),
        branch_id = COALESCE(target.branch_id, source.branch_id), position = COALESCE(target.position, source.position), updated_at = NOW()
        FROM employees source WHERE target.id = $1 AND source.id = $2`, [target.id, source.id]);
      await this.copyAssignments(client, 'branch_assignments', 'branch_id', source.id, target.id);
      await this.copyAssignments(client, 'schedule_assignments', 'schedule_id', source.id, target.id);
      await client.query("UPDATE device_users SET binding_status = 'historical' WHERE employee_id = $1", [source.id]);
      if (input.useAsAssignedClock) await client.query("UPDATE device_users SET binding_status = 'historical' WHERE employee_id = $1", [target.id]);
      await client.query('UPDATE device_users SET employee_id = $2 WHERE employee_id = $1', [source.id, target.id]);
      if (sourceClock && (!currentClock || input.useAsAssignedClock)) {
        await client.query("UPDATE device_users SET binding_status = 'active' WHERE id = $1", [sourceClock.id]);
        await this.recordClockEvent(client, target.id, sourceClock.id, currentClock?.id, 'identification');
      }
      await client.query("UPDATE employees SET identification_status = 'merged', merged_into_id = $2, updated_at = NOW() WHERE id = $1", [source.id, target.id]);
      return target.id;
    });
  }

  async assignClock(employeeId: string, clockRecordId: string): Promise<void> {
    const record = (await this.database.query<{ employee_id: string }>('SELECT employee_id FROM device_users WHERE id = $1', [clockRecordId])).rows[0];
    if (!record) throw new ConfigurationError('Registro de reloj no encontrado. Sincroniza sus empleados primero.');
    if (record.employee_id !== employeeId) {
      await this.identify(record.employee_id, { targetEmployeeId: employeeId, useAsAssignedClock: true });
      return;
    }
    await this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('employee-identification'))");
      await this.organization.refreshCurrentBranches(client);
      const employee = await this.lockEmployee(client, employeeId);
      const clock = (await client.query<ClockRow>(`SELECT u.id, u.employee_id, u.device_id, d.branch_id, u.binding_status
        FROM device_users u JOIN devices d ON d.id = u.device_id WHERE u.id = $1 FOR UPDATE OF u`, [clockRecordId])).rows[0];
      if (!clock || clock.employee_id !== employeeId) throw new ConfigurationError('La asignación cambió; actualiza la página.');
      if (!employee.branch_id || employee.branch_id !== clock.branch_id) throw new ConfigurationError('El reloj debe pertenecer a la sucursal del empleado.');
      const previous = (await client.query<{ id: string }>("SELECT id FROM device_users WHERE employee_id = $1 AND binding_status = 'active'", [employeeId])).rows[0];
      await client.query("UPDATE device_users SET binding_status = 'historical' WHERE employee_id = $1", [employeeId]);
      await client.query("UPDATE device_users SET binding_status = 'active' WHERE id = $1", [clockRecordId]);
      if (previous?.id !== clockRecordId) await this.recordClockEvent(client, employeeId, clockRecordId, previous?.id, 'assignment');
    });
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
    return { snapshots, merges, clockEvents, statusEvents };
  }

  private async lockEmployee(client: Queryable, id: string): Promise<EmployeeRow> {
    const employee = (await client.query<EmployeeRow>('SELECT id, branch_id, identification_status, first_name FROM employees WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!employee) throw new ConfigurationError('Empleado no encontrado.');
    return employee;
  }

  private async archiveMerge(client: Queryable, source: string, target: string) {
    await client.query(`INSERT INTO employee_merge_events (id, source_employee_id, target_employee_id, original_data)
      SELECT $1,$2,$3,jsonb_build_object('source', to_jsonb(s), 'targetBefore', to_jsonb(t),
        'clockRecords', (SELECT jsonb_agg(to_jsonb(u)) FROM device_users u WHERE u.employee_id = s.id),
        'branchAssignments', (SELECT jsonb_agg(to_jsonb(a)) FROM branch_assignments a WHERE a.employee_id = s.id),
        'scheduleAssignments', (SELECT jsonb_agg(to_jsonb(a)) FROM schedule_assignments a WHERE a.employee_id = s.id))
      FROM employees s CROSS JOIN employees t WHERE s.id = $2 AND t.id = $3`, [randomUUID(), source, target]);
  }

  private async copyAssignments(client: Queryable, table: string, column: string, source: string, target: string) {
    await client.query(`INSERT INTO ${table} (id, employee_id, ${column}, effective_from)
      SELECT gen_random_uuid(), $2, ${column}, effective_from FROM ${table} WHERE employee_id = $1
      AND NOT EXISTS (SELECT 1 FROM ${table} WHERE employee_id = $2)
      ON CONFLICT (employee_id, effective_from) DO NOTHING`, [source, target]);
  }

  private async recordClockEvent(client: Queryable, employee: string, clock: string, previous: string | undefined, reason: string) {
    await client.query('INSERT INTO employee_clock_events (id, employee_id, device_user_id, previous_device_user_id, reason) VALUES ($1,$2,$3,$4,$5)',
      [randomUUID(), employee, clock, previous ?? null, reason]);
  }
}
