import { randomUUID } from 'node:crypto';
import type { EvaluationSession, EvaluationWrite } from '../../domain/repositories/evaluation-repository.js';
import type { CalculatedDeduction, DailyEvaluation } from '../../domain/entities/schedule-evaluator.js';
import type { Queryable } from '../database/database.js';

const batchSize = 500;

export class BatchedEvaluationSession implements EvaluationSession {
  private readonly identities = new Map<string, string>();
  private readonly evaluations = new Map<string, EvaluationWrite & { id: string }>();
  private readonly incidents: object[] = [];
  private readonly deductions: object[] = [];

  constructor(private readonly database: Queryable, private readonly session: EvaluationSession) {}

  async snapshot() {
    const snapshot = await this.session.snapshot();
    const identities = (await this.database.query<{ key: string; id: string }>(`SELECT 'evaluation:' || subject_id || ':' || date::text AS key,id FROM attendance_evaluations
      UNION ALL SELECT 'incident:' || evaluation_id || ':' || kind,id FROM attendance_incidents
      UNION ALL SELECT 'deduction:' || trigger_incident_id,id FROM attendance_deductions`)).rows;
    for (const row of identities) this.identities.set(row.key, row.id);
    return snapshot;
  }

  private identity(key: string) {
    let id = this.identities.get(key);
    if (!id) { id = randomUUID(); this.identities.set(key, id); }
    return id;
  }

  async saveEvaluation(input: EvaluationWrite) {
    const id = this.identity(`evaluation:${input.subjectId}:${input.date}`);
    this.evaluations.set(id, { ...input, id });
    return id;
  }
  async saveIncident(evaluationId: string, subjectId: string, policyId: string, incident: DailyEvaluation['incidents'][number]) {
    const id = this.identity(`incident:${evaluationId}:${incident.kind}`);
    this.incidents.push({ id, evaluationId, subjectId, policyId, ...incident });
    return id;
  }
  async saveDeduction(subjectId: string, deduction: CalculatedDeduction) {
    const id = this.identity(`deduction:${deduction.triggerIncidentId}`);
    this.deductions.push({ id, subjectId, ...deduction });
    return id;
  }
  async updateCounters(id: string, counters: { arrival: number; meal: number }, deductionDays: number) {
    const evaluation = this.evaluations.get(id);
    if (!evaluation) throw new Error('No existe la evaluación que se quiere actualizar.');
    evaluation.result = { ...evaluation.result, counters, deductionDays };
  }

  private async write(sql: string, rows: object[]) {
    for (let offset = 0; offset < rows.length; offset += batchSize) {
      await this.database.query(sql, [JSON.stringify(rows.slice(offset, offset + batchSize))]);
    }
  }

  async reconcile(activeIncidentIds: string[], activeDeductionIds: string[], activeEvaluationIds: string[]) {
    await this.write(`INSERT INTO attendance_evaluations AS current (id,subject_id,employee_id,device_user_id,date,branch_id,schedule_id,policy_id,result)
      SELECT id,"subjectId","employeeId","deviceUserId",date,"branchId","scheduleId","policyId",result
      FROM jsonb_to_recordset($1::jsonb) AS input(id uuid,"subjectId" uuid,"employeeId" uuid,"deviceUserId" uuid,date date,"branchId" uuid,"scheduleId" uuid,"policyId" uuid,result jsonb)
      ON CONFLICT(subject_id,date) DO UPDATE SET branch_id=EXCLUDED.branch_id,schedule_id=EXCLUDED.schedule_id,policy_id=EXCLUDED.policy_id,result=EXCLUDED.result,active=TRUE,updated_at=NOW()
      WHERE (current.branch_id,current.schedule_id,current.policy_id,current.result,current.active)
        IS DISTINCT FROM (EXCLUDED.branch_id,EXCLUDED.schedule_id,EXCLUDED.policy_id,EXCLUDED.result,TRUE)`, [...this.evaluations.values()]);
    await this.write(`INSERT INTO attendance_incidents AS current(id,evaluation_id,subject_id,policy_id,kind,log_id,occurred_at,minutes)
      SELECT id,"evaluationId","subjectId","policyId",kind,"logId","occurredAt",minutes
      FROM jsonb_to_recordset($1::jsonb) AS input(id uuid,"evaluationId" uuid,"subjectId" uuid,"policyId" uuid,kind text,"logId" uuid,"occurredAt" timestamptz,minutes int)
      ON CONFLICT(evaluation_id,kind) DO UPDATE SET policy_id=EXCLUDED.policy_id,log_id=EXCLUDED.log_id,occurred_at=EXCLUDED.occurred_at,minutes=EXCLUDED.minutes,active=TRUE
      WHERE (current.policy_id,current.log_id,current.occurred_at,current.minutes,current.active)
        IS DISTINCT FROM (EXCLUDED.policy_id,EXCLUDED.log_id,EXCLUDED.occurred_at,EXCLUDED.minutes,TRUE)`, this.incidents);
    await this.write(`INSERT INTO attendance_deductions AS current(id,subject_id,trigger_incident_id,policy_id,category,window_start,window_end,incident_ids)
      SELECT id,"subjectId","triggerIncidentId","policyId",category,"windowStart","windowEnd","incidentIds"
      FROM jsonb_to_recordset($1::jsonb) AS input(id uuid,"subjectId" uuid,"triggerIncidentId" uuid,"policyId" uuid,category text,"windowStart" date,"windowEnd" date,"incidentIds" uuid[])
      ON CONFLICT(trigger_incident_id) DO UPDATE SET policy_id=EXCLUDED.policy_id,category=EXCLUDED.category,window_start=EXCLUDED.window_start,window_end=EXCLUDED.window_end,incident_ids=EXCLUDED.incident_ids,voided_at=NULL
      WHERE (current.policy_id,current.category,current.window_start,current.window_end,current.incident_ids,current.voided_at)
        IS DISTINCT FROM (EXCLUDED.policy_id,EXCLUDED.category,EXCLUDED.window_start,EXCLUDED.window_end,EXCLUDED.incident_ids,NULL::timestamptz)`, this.deductions);
    await this.session.reconcile(activeIncidentIds, activeDeductionIds, activeEvaluationIds);
  }
}
