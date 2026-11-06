import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest';
import { buildApp } from './helpers/build-test-app.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import type { DeviceUserRoleInput,DeviceUserRoleResult,DeviceUserRoleSnapshot,DeviceUserRoleTarget } from '../src/domain/entities/device-user-role.js';
import type { Device } from '../src/domain/entities/device.js';

const connection=process.env.INTEGRATION_DATABASE_URL;const integration=connection?describe:describe.skip;

integration('device user role operations and audit',()=>{
  const schema=`test_device_role_${randomUUID().replaceAll('-','')}`;
  let admin:Database;let database:Database;let services:Awaited<ReturnType<typeof buildApp>>;
  let deviceId:string;let otherDeviceId:string;let employeeId:string;let otherEmployeeId:string;let clockRecordId:string;let otherRecordId:string;
  let currentRole=14;let mode:'normal'|'last-admin'|'stale'|'unconfirmed'|'throw'='normal';let pending:(()=>Promise<void>)|undefined;
  const snapshot=(target:DeviceUserRoleTarget,role=currentRole):DeviceUserRoleSnapshot=>({userId:target.userId,uid:target.uid,role,administratorCount:mode==='last-admin'?1:2,totalUsers:3,measuredAt:new Date().toISOString()});
  const read=vi.fn(async(_device:Device,target:DeviceUserRoleTarget)=>snapshot(target));
  const write=vi.fn(async(_device:Device,input:DeviceUserRoleInput):Promise<DeviceUserRoleResult>=>{
    await pending?.();const before=snapshot(input);
    if(mode==='throw')throw new Error('sensitive transient transport detail');
    if(mode==='last-admin')return{status:'blocked',code:'LAST_ADMIN',before,after:null,error:'Primero asigna otro administrador en este reloj.'};
    if(mode==='stale')return{status:'blocked',code:'STALE_ROLE',before,after:null,error:'El rol cambió. Consulta nuevamente el reloj.'};
    currentRole=input.role;
    return{status:mode==='unconfirmed'?'unconfirmed':'succeeded',code:mode==='unconfirmed'?'NOT_VERIFIED':'VERIFIED',before,after:snapshot(input),error:mode==='unconfirmed'?'No se confirmó el resultado.':null};
  });
  async function call(method:'GET'|'POST',url:string,payload?:object,expected=200){const response=await services.app.inject({method,url,payload});expect(response.statusCode,response.body).toBe(expected);return response.body?response.json():null;}
  const targetPath=()=>`/employees/${employeeId}/clock-role`;
  const change=(role:0|14)=>call('POST',targetPath(),{clockRecordId,uid:2,expectedRole:currentRole,role});
  const history=()=>call('GET',`${targetPath()}/history`);
  const stored=async()=> (await database.query('SELECT role,uid,employee_id,device_user_id,raw_data FROM device_users WHERE id=$1',[clockRecordId])).rows[0];
  const sources=async()=>{
    const data:Record<string,unknown>={};for(const table of['attendance_logs','employees','device_user_photos','branch_assignments','employee_clock_events'])data[table]=(await database.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    return data;
  };
  beforeAll(async()=>{
    admin=new Database(connection!);await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped=new URL(connection!);scoped.searchParams.set('options',`-c search_path=${schema}`);database=new Database(scoped.toString());await runMigrations(database);
    services=await buildApp({database,clients:{getClient:()=>({testConnection:async()=>({raw:{}}),getUsers:async()=>[{userId:'1527',uid:2,name:'Diana',role:14,cardNumber:'9876',raw:{userId:'1527',uid:2,role:14,cardno:'9876',source:'preserved'}}],
      getAttendance:async()=>[{userId:'1527',deviceLogId:'original',occurredAt:new Date('2026-10-15T15:00:00Z'),raw:{original:true}}],getUserRole:read,setUserRole:write})}});
    const branch=(await call('POST','/branches',{name:'México roles'},201)).id;
    deviceId=(await call('POST','/devices',{name:'Reloj principal',ipAddress:'127.7.0.1',branchId:branch},201)).id;
    otherDeviceId=(await call('POST','/devices',{name:'Otro reloj de la misma sucursal',ipAddress:'127.7.0.2',branchId:branch},201)).id;
    for(const id of[deviceId,otherDeviceId]){
      await call('POST',`/devices/${id}/sync-users`);const user=(await call('GET',`/users?deviceId=${id}`))[0];
      await call('POST',`/employees/${user.employeeId}/identify`,{firstName:id===deviceId?'Diana':'Otra persona',lastName:'Valverde Roman'});
      if(id===deviceId){employeeId=user.employeeId;clockRecordId=user.id;}else{otherEmployeeId=user.employeeId;otherRecordId=user.id;}
      await call('POST',`/devices/${id}/sync-attendance`);
    }
    await database.query("INSERT INTO device_user_photos(device_id,device_user_id,content_type,image_data) VALUES($1,'1527','image/jpeg',$2)",[deviceId,Buffer.from('original-photo')]);
  },30000);
  afterAll(async()=>{await services?.app.close();await database?.close();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();}});

  it('reads live privileges for the exact active clock record and exposes the internal UID in the employee DTO',async()=>{
    const before=await sources();const observed=await call('GET',`${targetPath()}?clockRecordId=${clockRecordId}`);
    expect(observed.snapshot).toMatchObject({userId:'1527',uid:2,role:14,administratorCount:2});
    expect((await call('GET',`/employees/${employeeId}`)).clockRecords[0].uid).toBe(2);
    expect(await sources()).toEqual(before);expect(await history()).toHaveLength(0);
  });
  it('updates only verified privilege metadata, preserves identities and original evidence, and records independent changes',async()=>{
    const before=await sources();const original=await stored();
    const demoted=await change(0);expect(demoted.status).toBe('succeeded');expect((await stored()).role).toBe(0);
    expect(await stored()).toMatchObject({uid:original.uid,employee_id:original.employee_id,device_user_id:original.device_user_id,raw_data:{...original.raw_data,role:0}});
    const promoted=await change(14);expect(promoted.after.administratorCount).toBe(2);expect((await stored()).role).toBe(14);
    expect((await database.query('SELECT role FROM device_users WHERE id=$1',[otherRecordId])).rows[0].role).toBe(14);
    expect(await history()).toHaveLength(2);expect(await sources()).toEqual(before);
  });
  it('records stale and last-administrator blocks while keeping the cached role intact',async()=>{
    const before=await stored();mode='last-admin';expect((await change(0)).code).toBe('LAST_ADMIN');expect(await stored()).toEqual(before);
    mode='stale';expect((await change(0)).code).toBe('STALE_ROLE');expect(await stored()).toEqual(before);mode='normal';
  });
  it('does not report an unverified write as saved and does not expose sensitive transport errors',async()=>{
    const before=await stored();mode='unconfirmed';expect((await change(0)).status).toBe('unconfirmed');expect(await stored()).toEqual(before);
    currentRole=14;mode='throw';const result=await change(0);expect(result.status).toBe('unconfirmed');expect(JSON.stringify(result)).not.toContain('sensitive');
    expect(JSON.stringify(await history())).not.toContain('sensitive');mode='normal';
  });
  it('rejects invalid roles, stale UIDs and a different employee or historical binding before contacting the device',async()=>{
    const count=write.mock.calls.length;
    await call('POST',targetPath(),{clockRecordId,uid:2,expectedRole:14,role:7},400);
    await call('POST',targetPath(),{clockRecordId,uid:99,expectedRole:14,role:0},400);
    await call('POST',targetPath(),{clockRecordId:otherRecordId,uid:2,expectedRole:14,role:0},409);
    await database.query("UPDATE device_users SET binding_status='historical' WHERE id=$1",[clockRecordId]);
    await call('POST',targetPath(),{clockRecordId,uid:2,expectedRole:14,role:0},409);
    await database.query("UPDATE device_users SET binding_status='active' WHERE id=$1",[clockRecordId]);
    expect(write.mock.calls.length).toBe(count);
  });
  it('serializes changes with user synchronization and reads on the same clock while another clock remains available',async()=>{
    let unlock!:()=>void;let started!:()=>void;const reached=new Promise<void>((resolve)=>{started=resolve;});const pause=new Promise<void>((resolve)=>{unlock=resolve;});
    pending=async()=>{started();await pause;};
    const operation=change(0);await reached;
    try{
      await call('GET',`${targetPath()}?clockRecordId=${clockRecordId}`,undefined,409);
      await call('POST',`/devices/${deviceId}/sync-users`,undefined,409);
      await call('GET',`/employees/${otherEmployeeId}/clock-role?clockRecordId=${otherRecordId}`);
    }finally{unlock();pending=undefined;}
    expect((await operation).status).toBe('succeeded');
  });
});
