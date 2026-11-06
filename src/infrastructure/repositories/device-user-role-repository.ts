import { randomUUID } from 'node:crypto';
import type { DeviceUserRoleRepository } from '../../domain/repositories/device-user-role-repository.js';
import type { DeviceUserRoleChange, DeviceUserRoleInput, DeviceUserRoleResult, DeviceUserRoleSnapshot, EmployeeClockRoleBinding } from '../../domain/entities/device-user-role.js';
import type { Database, Queryable } from '../database/database.js';
import { PrismaDeviceDatasource } from '../datasources/device-datasource.js';
import { ConfigurationError, ConflictError } from '../../domain/errors/app-error.js';

const columns = `id,employee_id AS "employeeId",clock_record_id AS "clockRecordId",device_id AS "deviceId",user_id AS "userId",
  requested_role AS "requestedRole",status,before_reading AS before,after_reading AS after,code,error,started_at AS "startedAt",completed_at AS "completedAt"`;

async function binding(client: Queryable, employeeId: string, clockRecordId: string): Promise<EmployeeClockRoleBinding> {
  const user = (await client.query<Omit<EmployeeClockRoleBinding,'device'> & { deviceId: string }>(`SELECT u.employee_id AS "employeeId",u.id AS "clockRecordId",u.device_user_id AS "userId",
    u.uid,u.role,u.synced_at AS "syncedAt",u.device_id AS "deviceId" FROM device_users u JOIN employees e ON e.id=u.employee_id
    WHERE e.id=$1 AND u.id=$2 AND u.binding_status='active' AND e.identification_status='confirmed'`,[employeeId,clockRecordId])).rows[0];
  if (!user) throw new ConflictError('El reloj asignado cambió o la ficha no está identificada. Actualiza el empleado.');
  const device = await new PrismaDeviceDatasource(client).findById(user.deviceId);
  if (!device) throw new ConfigurationError('El reloj ya no está disponible.');
  return { ...user,device };
}

export class PrismaDeviceUserRoleRepository implements DeviceUserRoleRepository {
  constructor(private readonly database: Database) {}
  binding(employeeId: string, clockRecordId: string) { return binding(this.database,employeeId,clockRecordId); }
  async start(target: EmployeeClockRoleBinding, input: DeviceUserRoleInput) {
    return (await this.database.query<DeviceUserRoleChange>(`INSERT INTO device_user_role_changes (id,employee_id,clock_record_id,device_id,user_id,requested_role)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${columns}`,[randomUUID(),target.employeeId,target.clockRecordId,target.device.id,target.userId,input.role])).rows[0];
  }
  async saveObserved(target: EmployeeClockRoleBinding, snapshot: DeviceUserRoleSnapshot) {
    await this.database.transaction(async (client) => {
      await binding(client,target.employeeId,target.clockRecordId);
      if (snapshot.userId !== target.userId || snapshot.uid !== target.uid) throw new ConflictError('La identidad del usuario del reloj cambió.');
      await client.query(`UPDATE device_users SET role=$2,role_observed_at=$3,raw_data=jsonb_set(raw_data,'{role}',to_jsonb($2::int))
        WHERE id=$1 AND employee_id=$4 AND binding_status='active'`,[target.clockRecordId,snapshot.role,new Date(snapshot.measuredAt),target.employeeId]);
    });
  }
  async finish(id: string, result: DeviceUserRoleResult) {
    return this.database.transaction(async (client) => {
      const run = (await client.query<DeviceUserRoleChange>(`SELECT ${columns} FROM device_user_role_changes WHERE id=$1 FOR UPDATE`,[id])).rows[0];
      if (result.status === 'succeeded') {
        const current = (await client.query<{ uid: number | null; userId: string }>(`SELECT uid,device_user_id AS "userId" FROM device_users
          WHERE id=$1 AND employee_id=$2 AND binding_status='active' FOR UPDATE`,[run.clockRecordId,run.employeeId])).rows[0];
        if (result.after && current?.uid === result.after.uid && current.userId === result.after.userId && result.after.role === run.requestedRole) {
          await client.query(`UPDATE device_users SET role=$2,role_observed_at=$3,raw_data=jsonb_set(raw_data,'{role}',to_jsonb($2::int)) WHERE id=$1`,
            [run.clockRecordId,result.after.role,new Date(result.after.measuredAt)]);
        } else result = { ...result,status: 'unconfirmed',code: 'NOT_VERIFIED',error: 'El vínculo del empleado cambió o el rol no se verificó. Revisa el historial del reloj.' };
      }
      return (await client.query<DeviceUserRoleChange>(`UPDATE device_user_role_changes SET status=$2,before_reading=$3::jsonb,after_reading=$4::jsonb,
        code=$5,error=$6,completed_at=NOW() WHERE id=$1 RETURNING ${columns}`,[id,result.status,JSON.stringify(result.before),JSON.stringify(result.after),result.code,result.error])).rows[0];
    });
  }
  async history(employeeId: string) {
    return (await this.database.query<DeviceUserRoleChange>(`SELECT ${columns} FROM device_user_role_changes WHERE employee_id=$1 ORDER BY started_at DESC,id DESC LIMIT 20`,[employeeId])).rows;
  }
}
