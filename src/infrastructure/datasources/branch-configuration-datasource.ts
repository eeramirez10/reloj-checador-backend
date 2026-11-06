import { randomUUID } from 'node:crypto';
import type { BranchConfigurationDatasource } from '../../domain/datasources/branch-configuration-datasource.js';
import { configurationHistory, configurationToken, type BranchConfigurationContext, type BranchConfigurationInput } from '../../domain/entities/branch-configuration.js';
import { formatDateTimeInTimeZone } from '../../domain/entities/attendance-summary.js';
import { preserveOvertimeMargins, workOnlyScheduleSettings, type BranchPolicy, type WorkSchedule } from '../../domain/entities/organization.js';
import { effectiveVersion } from '../../domain/entities/employee-scheduling.js';
import { ConflictError } from '../../domain/errors/app-error.js';
import { NotFoundError } from '../../domain/errors/not-found-error.js';
import type { Database, Queryable } from '../database/database.js';
import { branchScopeSql } from '../security/access-context.js';

export const configurationScheduleColumns = `id, branch_id AS "branchId", name, effective_from::text AS "effectiveFrom",
  is_default AS "isDefault", settings, created_at AS "createdAt", superseded_from::text AS "supersededFrom",
  configuration_id AS "configurationId", deleted_at AS "deletedAt"`;
export const configurationPolicyColumns = `id, branch_id AS "branchId", effective_from::text AS "effectiveFrom", settings,
  created_at AS "createdAt", superseded_from::text AS "supersededFrom", configuration_id AS "configurationId", deleted_at AS "deletedAt"`;

async function readContexts(client: Queryable, branchId?: string): Promise<BranchConfigurationContext[]> {
  const branches = (await client.query<BranchConfigurationContext['branch']>(
    `SELECT id,name,time_zone AS "timeZone" FROM branches WHERE (${branchScopeSql('id')}) AND ($1::uuid IS NULL OR id=$1) ORDER BY name`, [branchId ?? null])).rows;
  if (branchId && !branches.length) throw new NotFoundError('Sucursal no encontrada.');
  const schedules = (await client.query<WorkSchedule>(`SELECT ${configurationScheduleColumns} FROM work_schedules
    WHERE ($1::uuid IS NULL OR branch_id=$1) ORDER BY created_at DESC,id DESC`, [branchId ?? null])).rows;
  const policies = (await client.query<BranchPolicy>(`SELECT ${configurationPolicyColumns} FROM branch_policies
    WHERE ($1::uuid IS NULL OR branch_id=$1) ORDER BY created_at DESC,id DESC`, [branchId ?? null])).rows;
  const firstDates = (await client.query<{ branchId: string; date: string }>(`SELECT b.id AS "branchId",
    MIN((a.occurred_at AT TIME ZONE b.time_zone)::date)::text AS date
    FROM attendance_logs a JOIN devices d ON d.id=a.device_id JOIN branches b ON b.id=COALESCE(a.branch_id,d.branch_id)
    WHERE ($1::uuid IS NULL OR b.id=$1) GROUP BY b.id`, [branchId ?? null])).rows;
  return branches.map((branch) => ({ branch, date: formatDateTimeInTimeZone(new Date(), branch.timeZone).slice(0,10),
    firstAttendanceDate: firstDates.find((item) => item.branchId === branch.id)?.date ?? null,
    schedules: schedules.filter((item) => item.branchId === branch.id), policies: policies.filter((item) => item.branchId === branch.id) }));
}

async function lockBranch(client: Queryable, branchId: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))::text', [`branch-schedule:${branchId}`]);
  if (!(await client.query('SELECT id FROM branches WHERE id=$1 FOR UPDATE', [branchId])).rows.length) throw new NotFoundError('Sucursal no encontrada.');
}

function checkVersion(context: BranchConfigurationContext, expected?: string | null) {
  if (expected !== undefined && expected !== configurationToken(context)) throw new ConflictError('Otro cambio actualizó la configuración de la sucursal. Actualiza la vista antes de guardar.');
}

async function rebuildTimeline(client: Queryable, branchId: string) {
  for (const table of ['work_schedules','branch_policies']) {
    const defaults = table === 'work_schedules' ? 'AND newer.is_default AND current.is_default' : '';
    await client.query(`UPDATE ${table} current SET superseded_from=(SELECT MIN(newer.effective_from) FROM ${table} newer
      WHERE newer.branch_id=current.branch_id AND newer.deleted_at IS NULL
      AND (newer.created_at,newer.id) > (current.created_at,current.id) AND newer.effective_from <= current.effective_from ${defaults})
      WHERE current.branch_id=$1 AND current.deleted_at IS NULL ${table === 'work_schedules' ? 'AND current.is_default' : ''}`, [branchId]);
  }
}

export class PrismaBranchConfigurationDatasource implements BranchConfigurationDatasource {
  constructor(private readonly database: Database) {}

  contexts() { return this.read(); }
  async context(branchId: string) { return (await this.read(branchId))[0]; }
  private read(branchId?: string) {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return readContexts(client, branchId);
    });
  }

  save(branchId: string, input: BranchConfigurationInput): Promise<void> {
    return this.database.transaction(async (client) => {
      await lockBranch(client, branchId);
      const context = (await readContexts(client, branchId))[0];
      checkVersion(context, input.expectedVersionId);
      const id = randomUUID();
      const policy = preserveOvertimeMargins(input.policy, effectiveVersion(context.policies, input.effectiveFrom)?.settings);
      const settings = { ...workOnlyScheduleSettings({ ...input.workHours, mealEnabled: false, mealStart: '00:00', mealEnd: '00:00',
        mealDurationMinutes: 60, recognitionMarginMinutes: input.recognitionMarginMinutes }), branchMeal: input.meal };
      await client.query(`INSERT INTO work_schedules (id,branch_id,name,effective_from,is_default,settings,configuration_id,created_at)
        VALUES ($1,$2,$3,$4,TRUE,$5::jsonb,$1,clock_timestamp())`,
      [id, branchId, `${context.branch.name} · jornada ${input.workHours.entryTime}–${input.workHours.exitTime}`, input.effectiveFrom, JSON.stringify(settings)]);
      await client.query(`INSERT INTO branch_policies (id,branch_id,effective_from,settings,configuration_id,created_at)
        VALUES ($1,$2,$3,$4::jsonb,$1,clock_timestamp())`, [id, branchId, input.effectiveFrom, JSON.stringify(policy)]);
      await rebuildTimeline(client, branchId);
    });
  }

  remove(branchId: string, versionId: string, expectedVersionId?: string | null): Promise<void> {
    return this.database.transaction(async (client) => {
      await lockBranch(client, branchId);
      const context = (await readContexts(client, branchId))[0];
      checkVersion(context, expectedVersionId);
      const version = configurationHistory(context).find((item) => item.id === versionId);
      if (!version) throw new NotFoundError('Versión no encontrada en esta sucursal.');
      if (version.deletedAt) return;
      // La baja conserva las referencias originales y excluye la versión de los recálculos.
      for (const table of ['work_schedules','branch_policies']) await client.query(
        `UPDATE ${table} SET deleted_at=clock_timestamp() WHERE branch_id=$1 AND (id=$2 OR configuration_id=$2) AND deleted_at IS NULL`, [branchId, versionId]);
      await rebuildTimeline(client, branchId);
    });
  }
}
