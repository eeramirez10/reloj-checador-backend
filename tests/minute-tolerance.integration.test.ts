import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { buildApp } from './helpers/build-test-app.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { PrismaEvaluationSession } from '../src/infrastructure/datasources/evaluation-datasource.js';
import { dateAtLocalTime } from '../src/domain/entities/local-date.js';
import { DEFAULT_OVERTIME_SETTINGS } from '../src/domain/entities/overtime.js';
import type { EmployeeAttendanceCard } from '../src/domain/entities/employee-attendance.js';
import type { DailyEvaluation } from '../src/domain/entities/schedule-evaluator.js';

const connection=process.env.INTEGRATION_DATABASE_URL;const integration=connection?describe:describe.skip;
const dates=['2026-10-19','2026-10-20','2026-10-21','2026-10-22'];

integration('minute-level tolerance recalculation and report consistency',()=>{
  const schema=`test_minute_tolerance_${randomUUID().replaceAll('-','')}`;
  let admin:Database;let database:Database;let services:Awaited<ReturnType<typeof buildApp>>;
  let branchId:string;let dailyId:string;let routeId:string;let mealId:string;
  async function call<T=Record<string,unknown>>(method:'GET'|'POST'|'PUT',url:string,payload?:object,expected=200):Promise<T>{const response=await services.app.inject({method,url,payload});expect(response.statusCode,response.body).toBe(expected);return response.body?response.json<T>():undefined as T;}
  const card=(id:string)=>call<EmployeeAttendanceCard>('GET',`/employees/${id}/attendance?from=${dates[0]}&to=${dates[3]}`);
  async function sources(){const result:Record<string,unknown>={};for(const table of['attendance_logs','device_users','employees','device_user_photos','employee_schedule_versions'])result[table]=(await database.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;return result;}
  beforeAll(async()=>{
    admin=new Database(connection!);await admin.query(`CREATE SCHEMA ${schema}`);const url=new URL(connection!);url.searchParams.set('options',`-c search_path=${schema}`);
    database=new Database(url.toString());await runMigrations(database);
    const entryTimes=['08:45:59','08:46:00','08:45:01','08:46:59'];
    const at=(date:string,time:string)=>new Date(dateAtLocalTime(date,time.slice(0,5),'America/Mexico_City').getTime()+Number(time.slice(6)||0)*1000);
    services=await buildApp({database,clients:{getClient:()=>({testConnection:async()=>({raw:{}}),
      getUsers:async()=>['1','2','3'].map(userId=>({userId,uid:Number(userId),name:`Persona ${userId}`,raw:{original:userId}})),
      getAttendance:async()=>dates.flatMap((date,index)=>['1','2','3'].flatMap(userId=>
        (userId==='3'?['08:30','15:00:37',index%2===0?'16:15:59':'16:16:00','18:30:15']:[entryTimes[index],'18:30:15']).map(time=>
          ({userId,deviceLogId:`${userId}-${date}-${time}`,occurredAt:at(date,time),raw:{original:`${userId}-${date}-${time}`}})))),
    })}});
    branchId=(await call<{id:string}>('POST','/branches',{name:'Minutos completos'},201)).id;
    await call('POST',`/branches/${branchId}/configuration`,{effectiveFrom:'2026-01-01',workHours:{workDays:[1,2,3,4,5],entryTime:'08:30',exitTime:'18:00'},
      meal:{mode:'configured',startTime:'15:00',endTime:'15:00',durationMinutes:60},recognitionMarginMinutes:30,
      policy:{entryToleranceMinutes:15,mealToleranceMinutes:15,entryAllowedTardies:1,mealAllowedTardies:1,accumulationMode:'calendar_month',accumulationDays:30}},201);
    const deviceId=(await call<{id:string}>('POST','/devices',{name:'Reloj de prueba',ipAddress:'127.8.0.1',branchId},201)).id;
    await call('POST',`/devices/${deviceId}/sync-users`);await call('POST',`/devices/${deviceId}/sync-attendance`);
    const users=await call<Array<{userId:string;employeeId:string}>>('GET',`/users?deviceId=${deviceId}`);dailyId=users.find(user=>user.userId==='1')!.employeeId;routeId=users.find(user=>user.userId==='2')!.employeeId;mealId=users.find(user=>user.userId==='3')!.employeeId;
    for(const [id,mode] of [[dailyId,'daily'],[routeId,'route'],[mealId,'daily']])await call('PUT',`/employees/${id}/scheduling`,{
      effectiveFrom:'2026-01-01',workHours:null,meal:id===dailyId?{enabled:false,startTime:'14:00',endTime:'14:00',durationMinutes:60}:null,
      mealMode:id===dailyId?'individual':'inherit',recognitionMarginMinutes:30,overtime:{...DEFAULT_OVERTIME_SETTINGS,enabled:true,workMode:mode}},204);
  },30000);
  afterAll(async()=>{await services?.app.close();await database?.close();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();}});

  it('removes legacy second-only incidents, voids obsolete deductions and preserves source evidence and observed work',async()=>{
    const beforeSources=await sources();const beforeCards=await Promise.all([card(dailyId),card(routeId),card(mealId)]);
    await database.transaction(async(client)=>{
      const session=new PrismaEvaluationSession(client);
      const days=(await client.query<{id:string;date:string;policy_id:string;result:DailyEvaluation}>('SELECT id,date::text,policy_id,result FROM attendance_evaluations WHERE subject_id=$1 ORDER BY date',[dailyId])).rows;
      const incidentIds:string[]=[];
      for(let index=0;index<days.length;index++){
        const day=days[index];const entry=day.result.punches.find(punch=>punch.movement==='entry')!;
        const incident={kind:'arrival' as const,logId:entry.id,occurredAt:entry.occurredAt,minutes:index===3?17:16};
        incidentIds.push(await session.saveIncident(day.id,dailyId,day.policy_id,incident));
        await client.query("UPDATE attendance_evaluations SET result=jsonb_set(result,'{incidents}',$2::jsonb) WHERE id=$1",[day.id,JSON.stringify([incident])]);
        await session.updateCounters(day.id,{arrival:index%2===0?1:0,meal:0},index%2===1?1:0);
      }
      for(const index of [1,3])await session.saveDeduction(dailyId,{policyId:days[index].policy_id,category:'arrival',triggerIncidentId:incidentIds[index],
        incidentIds:incidentIds.slice(index-1,index+1),windowStart:'2026-10-01',windowEnd:'2026-11-01'});
    });
    const legacyIncidents=(await database.query('SELECT id FROM attendance_incidents WHERE subject_id=$1 AND active ORDER BY id',[dailyId])).rows;
    const legacyDeductions=(await database.query('SELECT id FROM attendance_deductions WHERE subject_id=$1 AND voided_at IS NULL ORDER BY id',[dailyId])).rows;
    expect(legacyIncidents).toHaveLength(4);expect(legacyDeductions).toHaveLength(2);
    await call('POST','/attendance/recalculate');
    const daily=await card(dailyId);const route=await card(routeId);const meal=await card(mealId);
    for(const report of [daily,route]){
      expect(report.days.map(day=>day.incidents.filter(item=>item.kind==='arrival').map(item=>item.minutes))).toEqual([[],[16],[],[16]]);
      expect(report.days.map(day=>day.arrivalDelayMinutes)).toEqual([15,16,15,16]);
      expect(report.summary.arrivalTardies).toBe(2);
    }
    expect(meal.days.map(day=>day.incidents.filter(item=>item.kind==='meal_return').map(item=>item.minutes))).toEqual([[],[16],[],[16]]);
    for(const [index,report] of [daily,route,meal].entries())for(let day=0;day<4;day++){
      for(const key of ['entry','exit','mealDeparture','mealReturn','mealMinutes','workedMinutes','punches','overtime','routes'] as const)expect(report.days[day][key]).toEqual(beforeCards[index].days[day][key]);
    }
    const incidents=(await database.query('SELECT id,active FROM attendance_incidents WHERE subject_id=$1 ORDER BY id',[dailyId])).rows;
    expect(incidents.map(item=>item.id)).toEqual(legacyIncidents.map(item=>item.id));expect(incidents.filter(item=>item.active)).toHaveLength(2);
    const deductions=(await database.query('SELECT id,voided_at FROM attendance_deductions WHERE subject_id=$1 ORDER BY id',[dailyId])).rows;
    expect(deductions.map(item=>item.id)).toEqual(legacyDeductions.map(item=>item.id));expect(deductions.filter(item=>!item.voided_at)).toHaveLength(1);
    const exported=await call<{cards:EmployeeAttendanceCard[]}>('GET',`/attendance/cards/export?branchId=${branchId}&employeeStatus=active&from=${dates[0]}&to=${dates[3]}`);
    expect(exported.cards.find(item=>item.employee.id===dailyId)!.days).toEqual(daily.days);
    expect(await sources()).toEqual(beforeSources);
    await call('POST','/attendance/recalculate');expect((await card(dailyId)).days).toEqual(daily.days);
  });
});
