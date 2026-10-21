import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db/database.js';
import type { AssignmentTargets, Branch, BranchInput, BranchPolicy, WorkSchedule } from './schemas.js';
import { ConfigurationError } from './schemas.js';

const branchFields = `id, name, street, exterior_number AS "exteriorNumber", interior_number AS "interiorNumber",
  neighborhood, postal_code AS "postalCode", city, state, country, phone, email, manager_name AS "managerName",
  time_zone AS "timeZone", active, notes`;
const branchColumns = ['name', 'street', 'exterior_number', 'interior_number', 'neighborhood', 'postal_code', 'city', 'state', 'country', 'phone', 'email', 'manager_name', 'time_zone', 'active', 'notes'];
function branchValues(input: BranchInput): unknown[] {
  return [input.name, input.street, input.exteriorNumber, input.interiorNumber, input.neighborhood,
    input.postalCode, input.city, input.state, input.country, input.phone, input.email, input.managerName,
    input.timeZone, input.active, input.notes];
}

export class OrganizationRepository {
  constructor(private readonly database: Database) {}

  async refreshCurrentBranches(client: Queryable = this.database): Promise<void> {
    for (const [table, column] of [['employees', 'employee_id'], ['devices', 'device_id'], ['device_users', 'device_user_id']]) {
      await client.query(`UPDATE ${table} target SET branch_id = current_assignment.branch_id FROM (
        SELECT DISTINCT ON (${column}) ${column} AS target_id, assignment.branch_id FROM branch_assignments assignment
        JOIN branches b ON b.id = assignment.branch_id WHERE ${column} IS NOT NULL
        AND effective_from <= (NOW() AT TIME ZONE b.time_zone)::date ORDER BY ${column}, effective_from DESC
      ) current_assignment WHERE target.id = current_assignment.target_id AND target.branch_id IS DISTINCT FROM current_assignment.branch_id`);
    }
    await client.query(`UPDATE device_users u SET binding_status = 'historical' FROM employees e, devices d
      WHERE e.id = u.employee_id AND d.id = u.device_id AND u.binding_status = 'active'
      AND e.branch_id IS DISTINCT FROM d.branch_id`);
  }

  async listBranches(): Promise<Branch[]> {
    return (await this.database.query<Branch>(`SELECT ${branchFields} FROM branches ORDER BY name`)).rows;
  }

  async saveBranch(input: BranchInput, id?: string): Promise<Branch | undefined> {
    if (id) {
      return (await this.database.query<Branch>(`UPDATE branches SET ${branchColumns.map((column, index) => `${column} = $${index + 2}`).join(', ')}, updated_at = NOW()
        WHERE id = $1 RETURNING ${branchFields}`, [id, ...branchValues(input)])).rows[0];
    }
    return (await this.database.query<Branch>(`INSERT INTO branches (id, ${branchColumns.join(', ')})
      VALUES (${Array.from({ length: branchColumns.length + 1 }, (_, index) => `$${index + 1}`).join(', ')}) RETURNING ${branchFields}`,
    [randomUUID(), ...branchValues(input)])).rows[0];
  }

  async listPolicies(): Promise<BranchPolicy[]> {
    return (await this.database.query<BranchPolicy>(`SELECT id, branch_id AS "branchId", effective_from::text AS "effectiveFrom", settings, created_at AS "createdAt"
      FROM branch_policies ORDER BY effective_from DESC, created_at DESC`)).rows;
  }

  async addPolicy(branchId: string, input: Omit<BranchPolicy, 'id' | 'branchId'>): Promise<BranchPolicy> {
    return (await this.database.query<BranchPolicy>(`INSERT INTO branch_policies (id, branch_id, effective_from, settings)
      VALUES ($1, $2, $3, $4) RETURNING id, branch_id AS "branchId", effective_from::text AS "effectiveFrom", settings`,
    [randomUUID(), branchId, input.effectiveFrom, JSON.stringify(input.settings)])).rows[0];
  }

  async listSchedules(): Promise<WorkSchedule[]> {
    return (await this.database.query<WorkSchedule>(`SELECT id, branch_id AS "branchId", name, effective_from::text AS "effectiveFrom",
      is_default AS "isDefault", settings, created_at AS "createdAt" FROM work_schedules ORDER BY effective_from DESC, created_at DESC`)).rows;
  }

  async addSchedule(input: Omit<WorkSchedule, 'id'>): Promise<WorkSchedule> {
    return (await this.database.query<WorkSchedule>(`INSERT INTO work_schedules (id, branch_id, name, effective_from, is_default, settings)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, branch_id AS "branchId", name, effective_from::text AS "effectiveFrom", is_default AS "isDefault", settings`,
    [randomUUID(), input.branchId, input.name, input.effectiveFrom, input.isDefault, JSON.stringify(input.settings)])).rows[0];
  }

  async listAssignments() {
    return (await this.database.query(`SELECT id, employee_id AS "employeeId", device_user_id AS "deviceUserId",
      schedule_id AS "scheduleId", effective_from::text AS "effectiveFrom" FROM schedule_assignments WHERE employee_id IS NOT NULL ORDER BY effective_from DESC`)).rows;
  }

  async assignSchedule(scheduleId: string, targets: AssignmentTargets): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.saveScheduleTargets(client, scheduleId, targets);
      await this.refreshCurrentBranches(client);
    });
  }

  async assignBranch(branchId: string, targets: AssignmentTargets & { deviceIds?: string[] }): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.saveBranchTargets(client, branchId, targets);
      await this.refreshCurrentBranches(client);
    });
  }

  async assign(input: AssignmentTargets & { deviceIds?: string[]; branchId?: string; scheduleId?: string | null }) {
    await this.database.transaction(async (client) => {
      if (input.branchId) await this.saveBranchTargets(client, input.branchId, input);
      if (input.scheduleId !== undefined) await this.saveScheduleTargets(client, input.scheduleId, input);
      await this.refreshCurrentBranches(client);
    });
  }

  private async saveScheduleTargets(client: Queryable, scheduleId: string | null, targets: AssignmentTargets) {
    if (scheduleId) {
      const schedule = (await client.query<{ effective_from: string }>('SELECT effective_from::text FROM work_schedules WHERE id = $1', [scheduleId])).rows[0];
      if (!schedule) throw new ConfigurationError('Horario no encontrado.');
      if (targets.effectiveFrom < schedule.effective_from) throw new ConfigurationError('La asignación no puede iniciar antes de la vigencia del horario.');
    }
    for (const [column, ids] of [['employee_id', targets.employeeIds], ['device_user_id', targets.deviceUserIds]] as const) {
      for (const sourceId of new Set(ids)) {
        const user = column === 'device_user_id' ? (await client.query<{ employee_id: string | null }>('SELECT employee_id FROM device_users WHERE id = $1', [sourceId])).rows[0] : undefined;
        const targetColumn = user?.employee_id ? 'employee_id' : column;
        const id = user?.employee_id ?? sourceId;
        await client.query(`INSERT INTO schedule_assignments (id, ${targetColumn}, schedule_id, effective_from)
          VALUES ($1,$2,$3,$4) ON CONFLICT (${targetColumn}, effective_from) DO UPDATE SET schedule_id = EXCLUDED.schedule_id`,
        [randomUUID(), id, scheduleId, targets.effectiveFrom]);
      }
    }
  }

  private async saveBranchTargets(client: Queryable, branchId: string, targets: AssignmentTargets & { deviceIds?: string[] }) {
    for (const [column, table, ids] of [
        ['employee_id', 'employees', targets.employeeIds], ['device_user_id', 'device_users', targets.deviceUserIds],
        ['device_id', 'devices', targets.deviceIds ?? []],
      ] as const) {
        for (const id of new Set(ids)) {
          // Un usuario vinculado comparte la adscripción de su empleado.
          if (column === 'device_user_id') {
            const user = (await client.query<{ employee_id: string | null }>('SELECT employee_id FROM device_users WHERE id = $1', [id])).rows[0];
            if (user?.employee_id) { await this.assignEmployeeBranch(client, user.employee_id, branchId, targets.effectiveFrom); continue; }
          }
          await this.ensureBranchBaseline(client, table, column, id);
          await client.query(`INSERT INTO branch_assignments (id, ${column}, branch_id, effective_from)
            VALUES ($1,$2,$3,$4) ON CONFLICT (${column}, effective_from) DO UPDATE SET branch_id = EXCLUDED.branch_id`,
          [randomUUID(), id, branchId, targets.effectiveFrom]);
        }
      }
  }

  private async assignEmployeeBranch(client: Queryable, employeeId: string, branchId: string, date: string) {
    await this.ensureBranchBaseline(client, 'employees', 'employee_id', employeeId);
    await client.query(`INSERT INTO branch_assignments (id, employee_id, branch_id, effective_from) VALUES ($1,$2,$3,$4)
      ON CONFLICT (employee_id, effective_from) DO UPDATE SET branch_id = EXCLUDED.branch_id`, [randomUUID(), employeeId, branchId, date]);
  }

  private async ensureBranchBaseline(client: Queryable, table: string, column: string, id: string) {
    const target = (await client.query<{ branch_id: string | null }>(`SELECT branch_id FROM ${table} WHERE id = $1`, [id])).rows[0];
    if (target?.branch_id) await client.query(`INSERT INTO branch_assignments (id, ${column}, branch_id, effective_from)
      SELECT $1,$2,$3,'1900-01-01' WHERE NOT EXISTS (SELECT 1 FROM branch_assignments WHERE ${column} = $2)`,
    [randomUUID(), id, target.branch_id]);
  }
}
