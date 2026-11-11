import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { buildApp } from '../src/main.js';
import { Database,type Queryable } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { PrismaDeviceUserDatasource } from '../src/infrastructure/datasources/device-user-datasource.js';
import { PrismaAttendanceDatasource } from '../src/infrastructure/datasources/attendance-datasource.js';
import { PrismaEmployeeDiscardRepository } from '../src/infrastructure/repositories/employee-discard-repository.js';
import type { AuthPrincipal } from '../src/domain/entities/auth.js';

const connection=process.env.INTEGRATION_DATABASE_URL;
const integration=connection ? describe : describe.skip;
function deferred() { let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}; }
integration('pending employee discard and lossless attendance recovery',()=>{
  const schema=`test_discard_${randomUUID().replaceAll('-','')}`;
  const branches=[randomUUID(),randomUUID()];
  const devices=[randomUUID(),randomUUID(),randomUUID()];
  const origin='http://127.0.0.1:5173';
  const password='Discard test password 2026!';
  let admin:Database;let database:Database;let services:Awaited<ReturnType<typeof buildApp>>;
  let users:PrismaDeviceUserDatasource;let attendance:PrismaAttendanceDatasource;let actor:AuthPrincipal;
  type Session={cookie:string;csrf:string};
  let root:Session;let hr:Session;let manager:Session;let employee:Session;
  let sequence=100;let address=1;let discardedId:string;
  async function login(username:string) {
    const response=await services.app.inject({method:'POST',url:'/auth/login',remoteAddress:`127.3.0.${address++}`,headers:{origin},payload:{username,password}});
    expect(response.statusCode,response.body).toBe(204);
    const cookie=String(response.headers['set-cookie']).split(';')[0];
    const me=await services.app.inject({method:'GET',url:'/auth/me',headers:{cookie}});
    return {cookie,csrf:me.json().csrfToken};
  }
  async function call(session:Session,method:'GET'|'POST'|'PATCH',url:string,payload?:object,status=200) {
    const response=await services.app.inject({method,url,headers:{origin,cookie:session.cookie,'x-csrf-token':session.csrf},payload});
    expect(response.statusCode,response.body).toBe(status);return response.body ? response.json() : null;
  }
  async function pending(deviceId=devices[0],userId=String(sequence++)) {
    await users.upsert(deviceId,{userId,name:`Persona ${userId}`,raw:{original:true}});
    const row=(await database.query<{id:string}>('SELECT employee_id AS id FROM device_users WHERE device_id=$1 AND device_user_id=$2',[deviceId,userId])).rows[0];
    return {id:row.id,userId,deviceId};
  }
  const event=(userId:string)=>({userId,deviceLogId:randomUUID(),occurredAt:new Date('2026-11-09T15:00:00Z'),raw:{source:'native'}});
  async function stored(id:string) { return (await database.query('SELECT * FROM employees WHERE id=$1',[id])).rows[0]; }
  async function discard(person:{id:string},session=root) {return call(session,'POST',`/employees/${person.id}/discard`,{},204);}
  beforeAll(async()=>{
    admin=new Database(connection!);await admin.query(`CREATE SCHEMA ${schema}`);
    const url=new URL(connection!);url.searchParams.set('options',`-c search_path=${schema}`);
    database=new Database(url.toString());await runMigrations(database);services=await buildApp({database});
    const account=await services.auth.save(null,{username:'admin',name:'Administrador',role:'admin',branchIds:[],isActive:true},password);
    await database.query('UPDATE auth_accounts SET must_change_password=FALSE WHERE id=$1',[account.id]);
    for(const [index,id]of branches.entries()) await database.query('INSERT INTO branches(id,name) VALUES($1,$2)',[id,index?'Cancún':'México']);
    for(const [index,id]of devices.entries()) await database.query("INSERT INTO devices(id,name,ip_address,branch_id,driver) VALUES($1,$2,$3,$4,'node')",[id,`Clock ${index}`,`127.40.0.${index+1}`,branches[index===2?1:0]]);
    const linked=randomUUID();await database.query("INSERT INTO employees(id,name,first_name,branch_id) VALUES($1,'Confirmado','Confirmado',$2)",[linked,branches[0]]);
    const storedAccount=(await services.auth.repository.credentials('admin'))!;
    actor={...storedAccount,sessionHash:'test',csrfToken:'test'};
    for(const [username,role,employeeId]of [['human-resources','hr',null],['manager','manager',null],['employee','employee',linked]]as const) {
      const id=randomUUID();await database.query('INSERT INTO auth_accounts(id,username,name,password_hash,role,employee_id,must_change_password) VALUES($1,$2,$2,$3,$4,$5,FALSE)',[id,username,storedAccount.passwordHash,role,employeeId]);
      if(role!=='employee')await database.query('INSERT INTO auth_account_branches VALUES($1,$2)',[id,branches[0]]);
    }
    root=await login('admin');hr=await login('human-resources');manager=await login('manager');employee=await login('employee');
    users=new PrismaDeviceUserDatasource(database);attendance=new PrismaAttendanceDatasource(database);
  },60000);
  afterAll(async()=>{await services?.app.close();await database?.close();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();}});

  it('permits only scoped RH/admin with origin and CSRF checks, retaining identities and enrollment evidence',async()=>{
    const person=await pending();discardedId=person.id;
    const before=await stored(person.id);
    await database.query("INSERT INTO device_user_photos(device_id,device_user_id,content_type,image_data) VALUES($1,$2,'image/jpeg',$3)",[person.deviceId,person.userId,Buffer.from([255,216,255,217])]);
    const link=(await database.query('SELECT to_jsonb(u) AS row FROM device_users u WHERE employee_id=$1',[person.id])).rows;
    for(const session of [manager,employee])await call(session,'POST',`/employees/${person.id}/discard`,{},403);
    const noCsrf=await services.app.inject({method:'POST',url:`/employees/${person.id}/discard`,headers:{origin,cookie:hr.cookie},payload:{}});expect(noCsrf.statusCode).toBe(403);
    const badOrigin=await services.app.inject({method:'POST',url:`/employees/${person.id}/discard`,headers:{origin:'http://attacker.test',cookie:hr.cookie,'x-csrf-token':hr.csrf},payload:{}});expect(badOrigin.statusCode).toBe(403);
    await discard(person,hr);
    const after=await stored(person.id);expect(after.discarded_at).not.toBeNull();
    for(const field of ['id','identification_status','hire_date','termination_date','is_active'])expect(after[field]).toEqual(before[field]);
    expect((await database.query('SELECT to_jsonb(u) AS row FROM device_users u WHERE employee_id=$1',[person.id])).rows).toEqual(link);
    expect(Buffer.from((await database.query('SELECT image_data FROM device_user_photos WHERE device_id=$1 AND device_user_id=$2',[person.deviceId,person.userId])).rows[0].image_data)).toEqual(Buffer.from([255,216,255,217]));
    expect((await call(root,'GET','/employees?limit=500')).some((row:any)=>row.id===person.id)).toBe(false);
    expect((await call(root,'GET',`/users?deviceId=${person.deviceId}`)).some((row:any)=>row.employeeId===person.id)).toBe(false);
    const report=await call(root,'GET',`/attendance/cards/export?branchId=${branches[0]}&employeeStatus=active&from=2026-11-09&to=2026-11-09`);
    expect(report.cards.some((card:any)=>card.employee.id===person.id)).toBe(false);
    expect((await database.query("SELECT COUNT(*)::int AS count FROM employee_discard_events WHERE employee_id=$1 AND kind='discarded'",[person.id])).rows[0].count).toBe(1);
    expect((await database.query("SELECT COUNT(*)::int AS count FROM employee_status_events WHERE employee_id=$1",[person.id])).rows[0].count).toBe(1);
    await call(root,'POST',`/employees/${person.id}/identify`,{},403);
  });
  it('keeps discarded enrollment hidden after repeated user synchronization and attendance-link preparation',async()=>{
    const link=(await database.query<{device_id:string;device_user_id:string}>('SELECT device_id,device_user_id FROM device_users WHERE employee_id=$1',[discardedId])).rows[0];
    for(let index=0;index<2;index++)await users.upsert(link.device_id,{userId:link.device_user_id,name:'Nombre actualizado del reloj',raw:{index}});
    await users.ensureFromAttendance(link.device_id,[link.device_user_id]);
    await services.employeeNames.populateMissing();
    expect((await stored(discardedId)).discarded_at).not.toBeNull();
    expect((await database.query('SELECT employee_id FROM device_users WHERE device_id=$1 AND device_user_id=$2',[link.device_id,link.device_user_id])).rows[0].employee_id).toBe(discardedId);
    expect(await services.employees.findById(discardedId)).toBeUndefined();
  });
  it('restores the same pending employee once when native attendance is committed, preserving original punches',async()=>{
    const link=(await database.query<{device_id:string;device_user_id:string}>('SELECT device_id,device_user_id FROM device_users WHERE employee_id=$1',[discardedId])).rows[0];
    const punch=event(link.device_user_id);
    expect(await attendance.insertBatchIfNew(link.device_id,[punch,punch])).toBe(1);
    expect(await attendance.insertIfNew(link.device_id,punch)).toBe(false);
    const restored=await services.employees.findById(discardedId);expect(restored).toMatchObject({id:discardedId,identificationStatus:'pending',hasAttendance:true});
    const events=(await database.query('SELECT kind,attendance_log_id FROM employee_discard_events WHERE employee_id=$1 ORDER BY created_at',[discardedId])).rows;
    expect(events.map(row=>row.kind)).toEqual(['discarded','restored']);expect(events[1].attendance_log_id).not.toBeNull();
    await call(root,'POST',`/employees/${discardedId}/discard`,{},400);
    const history=await call(root,'GET',`/employees/${discardedId}/history`);expect(history.discardEvents).toHaveLength(2);
  });
  it('restores from legacy file imports and remains idempotent when the file is submitted again',async()=>{
    const person=await pending(devices[0],'000606');await discard(person);
    const payload={deviceId:person.deviceId,branchId:branches[0],fileName:'recuperacion.txt',content:`01${person.userId.padStart(7,'0')}0000019-10-260010830B`};
    const preview=await call(hr,'POST','/attendance/imports/preview',payload);
    const imported=await call(hr,'POST','/attendance/imports',{...payload,expectedToken:preview.token});expect(imported.insertedCount).toBe(1);
    expect((await stored(person.id)).discarded_at).toBeNull();expect((await services.employees.findById(person.id))!.identificationStatus).toBe('pending');
    await call(hr,'POST','/attendance/imports',{...payload,expectedToken:preview.token});
    expect((await database.query("SELECT COUNT(*)::int AS count FROM employee_discard_events WHERE employee_id=$1 AND kind='restored'",[person.id])).rows[0].count).toBe(1);
  });
  it('checks historical and deleted clocks, while equal IDs on unrelated clocks remain independent',async()=>{
    const person=await pending();const historical=await pending(devices[1]);
    await attendance.insertIfNew(historical.deviceId,event(historical.userId));
    await database.query("UPDATE device_users SET employee_id=$1,binding_status='historical' WHERE device_id=$2 AND device_user_id=$3",[person.id,historical.deviceId,historical.userId]);
    await database.query('UPDATE devices SET deleted_at=NOW() WHERE id=$1',[historical.deviceId]);
    await call(hr,'POST',`/employees/${person.id}/discard`,{},400);
    const separate=await pending(devices[0],'900');const other=await pending(devices[2],'900');
    await attendance.insertIfNew(other.deviceId,event(other.userId));await discard(separate,hr);
    const cross=await pending();const crossClock=await pending(devices[2]);
    await database.query("UPDATE device_users SET employee_id=$1,binding_status='historical' WHERE device_id=$2 AND device_user_id=$3",[cross.id,crossClock.deviceId,crossClock.userId]);
    await call(hr,'POST',`/employees/${cross.id}/discard`,{},403);
  });
  it('rejects confirmed employees and pending records with protected business references',async()=>{
    const confirmed=await call(root,'POST','/employees',{firstName:'Confirmado nuevo',branchId:branches[0]},201);
    await call(root,'POST',`/employees/${confirmed.id}/discard`,{},400);
    const person=await pending();await database.query("INSERT INTO auth_accounts(id,username,name,password_hash,role,employee_id) VALUES($1,'legacy-link','Legacy','test-only','manager',$2)",[randomUUID(),person.id]);
    await call(root,'POST',`/employees/${person.id}/discard`,{},400);expect((await stored(person.id)).discarded_at).toBeNull();
  });
  it('rolls back recovery and its audit if attendance persistence fails',async()=>{
    const person=await pending();await discard(person);
    await expect(database.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))::text',[`attendance-source:${person.deviceId}`]);
      await new PrismaAttendanceDatasource(client).insertIfNew(person.deviceId,event(person.userId));throw new Error('forced rollback');
    })).rejects.toThrow('forced rollback');
    expect((await stored(person.id)).discarded_at).not.toBeNull();
    expect((await database.query("SELECT COUNT(*)::int AS count FROM employee_discard_events WHERE employee_id=$1 AND kind='restored'",[person.id])).rows[0].count).toBe(0);
  });
  it('rejects discard when a concurrent ingest commits attendance first',async()=>{
    const person=await pending();const locked=deferred();const release=deferred();const attempted=deferred();
    const ingest=database.transaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))::text',[`attendance-source:${person.deviceId}`]);locked.resolve();await release.promise;
      await new PrismaAttendanceDatasource(client).insertIfNew(person.deviceId,event(person.userId));
    });
    await locked.promise;
    const repository=new PrismaEmployeeDiscardRepository({transaction:operation=>database.transaction(client=>operation(new Proxy(client,{get(target,key){
      if(key==='query')return async(text:string,values?:unknown[])=>{if(values?.[0]===`attendance-source:${person.deviceId}`)attempted.resolve();return target.query(text,values)};
      return Reflect.get(target,key);
    }}) as Queryable))});
    const discard=repository.discard(person.id,actor,'Concurrent discard');const rejected=expect(discard).rejects.toMatchObject({code:'INVALID_CONFIGURATION'});
    await attempted.promise;release.resolve();await ingest;await rejected;expect((await stored(person.id)).discarded_at).toBeNull();
  });
  it('restores the same identity when discard commits before a concurrent ingest',async()=>{
    const person=await pending();const marked=deferred();const release=deferred();
    const repository=new PrismaEmployeeDiscardRepository({transaction:operation=>database.transaction(client=>operation(new Proxy(client,{get(target,key){
      if(key==='query')return async(text:string,values?:unknown[])=>{const result=await target.query(text,values);if(text.startsWith('UPDATE employees SET discarded_at')){marked.resolve();await release.promise}return result};
      return Reflect.get(target,key);
    }}) as Queryable))});
    const discarded=repository.discard(person.id,actor,'Concurrent discard');await marked.promise;
    const inserted=attendance.insertIfNew(person.deviceId,event(person.userId));release.resolve();await discarded;expect(await inserted).toBe(true);
    expect((await stored(person.id)).discarded_at).toBeNull();
    expect((await database.query('SELECT kind FROM employee_discard_events WHERE employee_id=$1 ORDER BY created_at',[person.id])).rows.map(row=>row.kind)).toEqual(['discarded','restored']);
  });
});
