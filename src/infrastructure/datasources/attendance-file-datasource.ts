import { createHash, randomUUID } from 'node:crypto';
import type { AttendanceFileDatasource } from '../../domain/datasources/attendance-file-datasource.js';
import { summarizeFileRows, type AttendanceFileInput, type AttendanceFilePreview, type AttendanceFileReceipt, type AttendanceFileHistoryEntry, type AttendanceFileRow, type ParsedFileRow } from '../../domain/entities/attendance-file.js';
import { dateAtLocalTime } from '../../domain/entities/local-date.js';
import { formatDateTimeInTimeZone } from '../../domain/entities/attendance-summary.js';
import { ConfigurationError, ConflictError } from '../../domain/errors/app-error.js';
import type { Database, Queryable } from '../database/database.js';
import { PrismaDeviceUserDatasource } from './device-user-datasource.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
interface UserLink { userId: string; employeeId: string; employeeName: string }

export class PrismaAttendanceFileDatasource implements AttendanceFileDatasource {
  constructor(private readonly database: Database) {}

  preview(input: AttendanceFileInput, rows: ParsedFileRow[]): Promise<AttendanceFilePreview> {
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return this.inspect(client,input,rows);
    });
  }

  private async inspect(client: Queryable, input: AttendanceFileInput, parsed: ParsedFileRow[]): Promise<AttendanceFilePreview> {
    const device = (await client.query<{ branchId: string; timeZone: string }>(`SELECT d.branch_id AS "branchId",b.time_zone AS "timeZone"
      FROM devices d JOIN branches b ON b.id=d.branch_id WHERE d.id=$1`,[input.deviceId])).rows[0];
    if (!device || device.branchId !== input.branchId) throw new ConfigurationError('Selecciona un reloj de la sucursal indicada.');
    const assignments = (await client.query<{ branchId: string; effectiveFrom: string }>(`SELECT branch_id AS "branchId",effective_from::text AS "effectiveFrom"
      FROM branch_assignments WHERE device_id=$1 ORDER BY effective_from DESC`,[input.deviceId])).rows;
    const links = (await client.query<UserLink>(`SELECT u.device_user_id AS "userId",e.id AS "employeeId",e.name AS "employeeName"
      FROM device_users u JOIN employees e ON e.id=u.employee_id WHERE u.device_id=$1`,[input.deviceId])).rows;
    const rows: AttendanceFileRow[] = parsed.map((row) => ({ ...row, status: row.issue ? 'invalid' : 'new' }));
    const seen = new Map<string,number>();
    for (const row of rows) {
      if (row.status === 'invalid') continue;
      const branch = assignments.find((item) => item.effectiveFrom <= row.date!);
      if (branch && branch.branchId !== input.branchId) { row.status = 'invalid'; row.issue = 'El reloj estaba asignado a otra sucursal en esta fecha.'; continue; }
      const matches = links.filter((link) => link.userId.replace(/^0+(?=\d)/,'') === row.userId);
      if (matches.length > 1) { row.status = 'ambiguous'; row.issue = 'Varios IDs de este reloj coinciden al quitar ceros iniciales.'; continue; }
      if (matches[0]) Object.assign(row,{ userId: matches[0].userId, employeeId: matches[0].employeeId, employeeName: matches[0].employeeName });
      else row.unknownUser = true;
      try { row.occurredAt = dateAtLocalTime(row.date!,row.time!,device.timeZone).toISOString(); }
      catch { row.status = 'invalid'; row.issue = 'La hora no existe en la zona horaria de la sucursal.'; continue; }
      const key = `${row.userId}:${row.occurredAt}`;
      if (seen.has(key)) { row.status = 'duplicate'; row.issue = `Repite la checada de la línea ${seen.get(key)}.`; }
      else seen.set(key,row.lineNumber);
    }
    const wanted = rows.filter((row) => row.status === 'new').map((row) => ({ user_id: row.userId, occurred_at: row.occurredAt }));
    const stored = wanted.length ? (await client.query<{ userId: string; minute: string; id: string; occurredAt: Date }>(`
      SELECT wanted.user_id AS "userId",wanted.occurred_at::text AS minute,a.id,a.occurred_at AS "occurredAt"
      FROM jsonb_to_recordset($2::jsonb) AS wanted(user_id text,occurred_at timestamptz)
      CROSS JOIN LATERAL (SELECT id,occurred_at FROM attendance_logs WHERE device_id=$1 AND user_id=wanted.user_id
        AND occurred_at >= wanted.occurred_at AND occurred_at < wanted.occurred_at + INTERVAL '1 minute'
        ORDER BY occurred_at,id LIMIT 3) a`,[input.deviceId,JSON.stringify(wanted)])).rows : [];
    const byMinute = new Map<string,typeof stored>();
    for (const log of stored) {
      const key = `${log.userId}:${new Date(log.minute).toISOString()}`;
      const group = byMinute.get(key) ?? []; group.push(log); byMinute.set(key,group);
    }
    for (const row of rows.filter((item) => item.status === 'new')) {
      const matches = byMinute.get(`${row.userId}:${row.occurredAt}`) ?? [];
      if (!matches.length) continue;
      row.status = matches.length === 1 ? 'existing' : 'ambiguous';
      row.logId = matches.length === 1 ? matches[0].id : undefined;
      row.matchingTimes = matches.map((log) => formatDateTimeInTimeZone(log.occurredAt,device.timeZone));
      if (matches.length > 1) row.issue = 'Hay varias checadas del reloj en este minuto; se conserva la evidencia sin fusionarla.';
    }
    const summary = summarizeFileRows(rows);
    const token = hash(JSON.stringify({ input, timeZone: device.timeZone, rows, assignments }));
    return { deviceId: input.deviceId, branchId: input.branchId, fileName: input.fileName, timeZone: device.timeZone, token, rows, summary };
  }

  async import(input: AttendanceFileInput, rows: ParsedFileRow[], expectedToken: string) {
    return this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))::text',[`attendance-source:${input.deviceId}`]);
      const previous = (await client.query<{ report: AttendanceFileReceipt }>(`SELECT report FROM attendance_file_imports WHERE device_id=$1 AND content_hash=$2`,[input.deviceId,hash(input.content)])).rows[0];
      if (previous) {
        if (previous.report.branchId !== input.branchId) throw new ConflictError('Este archivo ya fue registrado para otra sucursal del reloj.');
        return { receipt: previous.report, alreadyImported: true };
      }
      const preview = await this.inspect(client,input,rows);
      if (preview.token !== expectedToken) throw new ConflictError('Las checadas o las asociaciones cambiaron. Vuelve a revisar el archivo antes de importar.');
      if (!preview.summary.new && !preview.summary.existing) throw new ConfigurationError('No hay checadas nuevas ni existentes que puedan registrarse.');
      const id = randomUUID();
      const newRows = preview.rows.filter((row) => row.status === 'new');
      await new PrismaDeviceUserDatasource(client).ensureFromAttendance(input.deviceId,newRows.map((row) => row.userId!));
      for (const row of newRows) {
        row.logId = randomUUID();
        await client.query(`INSERT INTO attendance_logs (id,device_id,event_key,user_id,occurred_at,raw_data,branch_id)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,[row.logId,input.deviceId,`talavie:${row.userId}:${row.occurredAt}`,row.userId,row.occurredAt,
          JSON.stringify({ source: 'talavie_file', importId: id, fileName: input.fileName, lineNumber: row.lineNumber, originalLine: row.rawLine,
            deviceLocalTime: `${row.date} ${row.time}:00`, precision: 'minute', marker: row.marker, prefix: row.prefix, padding: row.padding, terminalCode: row.terminalCode }),input.branchId]);
      }
      const receipt: AttendanceFileReceipt = { ...preview, id, createdAt: new Date().toISOString(), insertedCount: newRows.length };
      await client.query(`INSERT INTO attendance_file_imports (id,device_id,branch_id,file_name,content_hash,original_content,report)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,[id,input.deviceId,input.branchId,input.fileName,hash(input.content),input.content,JSON.stringify(receipt)]);
      return { receipt, alreadyImported: false };
    });
  }

  async history(deviceId: string): Promise<AttendanceFileHistoryEntry[]> {
    return (await this.database.query<{ report: AttendanceFileHistoryEntry }>(`SELECT report - 'rows' - 'token' AS report FROM attendance_file_imports WHERE device_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`,[deviceId])).rows.map((row) => row.report);
  }
}
