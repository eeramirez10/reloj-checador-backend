import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { buildApp } from '../src/main.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { dateAtLocalTime } from '../src/domain/entities/local-date.js';
import { ManageLeave } from '../src/domain/use-cases/manage-leave.js';
import { PrismaLeaveRepository } from '../src/infrastructure/repositories/leave-repository.js';
import type { LeaveInput,LeaveRequest } from '../src/domain/entities/leave.js';
import type { Company } from '../src/domain/entities/company.js';

const connection=process.env.INTEGRATION_DATABASE_URL;
const integration=connection?describe:describe.skip;
integration('offsite work, administrative cancellation and bulk company assignments',()=>{
  const schema=`test_offsite_${randomUUID().replaceAll('-','')}`;
  const branches=[randomUUID(),randomUUID()];const people=Array.from({length:5},()=>randomUUID());const device=randomUUID();
  const origin='http://127.0.0.1:5173',password='Offsite test password 2026!';
  type Session={id:string;cookie:string;csrf:string};
  let admin:Database;let database:Database;let services:Awaited<ReturnType<typeof buildApp>>;
  let root:Session;let hr:Session;let boss:Session;let employee:Session;let other:Session;let alfa:Company;let beta:Company;let client:LeaveRequest;let cancelledVacation:LeaveRequest;let address=1;
  async function login(username:string) {
    const response=await services.app.inject({method:'POST',url:'/auth/login',remoteAddress:`127.9.0.${address++}`,headers:{origin},payload:{username,password}});expect(response.statusCode,response.body).toBe(204);
    const cookie=String(response.headers['set-cookie']).split(';')[0];const me=await services.app.inject({method:'GET',url:'/auth/me',headers:{cookie}});
    return {id:me.json().id,cookie,csrf:me.json().csrfToken};
  }
  async function call(session:Session,method:'GET'|'POST'|'PATCH',url:string,payload?:object,status=200) {
    const response=await services.app.inject({method,url,headers:{origin,cookie:session.cookie,'x-csrf-token':session.csrf},payload});expect(response.statusCode,response.body).toBe(status);return response.body?response.json():null;
  }
  function input(kind:LeaveInput['kind'],date:string,extra:Partial<LeaveInput>={}):LeaveInput {return {employeeId:people[0],kind,from:date,to:date,authorizedTime:null,paid:true,useVacation:false,reason:'Solicitud de prueba',...extra};}
  async function create(value:LeaveInput,session=employee):Promise<LeaveRequest> {const preview=await call(session,'POST','/me/leave-requests/preview',value);return call(session,'POST','/me/leave-requests',{input:value,previewToken:preview.token,sourceKey:randomUUID()},201);}
  const resolve=(session:Session,request:LeaveRequest,action='approve',comments='Autorizado',status=200)=>call(session,'POST',`/leave-requests/${request.id}/resolve`,{action,expectedVersion:request.version,comments},status);
  const card=(date:string)=>call(employee,'GET',`/me/attendance/card?from=${date}&to=${date}`);
  const logs=async()=>(await database.query('SELECT to_jsonb(a) AS row FROM attendance_logs a ORDER BY id')).rows;
  beforeAll(async()=>{
    admin=new Database(connection!);await admin.query(`CREATE SCHEMA ${schema}`);const url=new URL(connection!);url.searchParams.set('options',`-c search_path=${schema}`);
    database=new Database(url.toString());await runMigrations(database);services=await buildApp({database});
    const account=await services.auth.save(null,{username:'admin',name:'Admin',role:'admin',branchIds:[],isActive:true},password);await database.query('UPDATE auth_accounts SET must_change_password=FALSE WHERE id=$1',[account.id]);root=await login('admin');
    alfa=await call(root,'POST','/companies',{name:'Alfa'},201);beta=await call(root,'POST','/companies',{name:'Beta'},201);
    for(const [index,id]of branches.entries()) {
      await database.query('INSERT INTO branches(id,name) VALUES($1,$2)',[id,index?'Cancún':'México']);
      await database.query(`INSERT INTO work_schedules(id,branch_id,name,effective_from,is_default,settings) VALUES($1,$2,'Jornada','2026-01-01',TRUE,$3::jsonb)`,[randomUUID(),id,JSON.stringify({workDays:[1,2,3,4,5,6,7],entryTime:'08:30',exitTime:'17:30',mealEnabled:true,mealStart:'12:00',mealEnd:'13:00',mealDurationMinutes:60,recognitionMarginMinutes:30})]);
      await database.query(`INSERT INTO branch_policies(id,branch_id,effective_from,settings) VALUES($1,$2,'2026-01-01',$3::jsonb)`,[randomUUID(),id,JSON.stringify({entryToleranceMinutes:0,mealToleranceMinutes:0,entryAllowedTardies:0,mealAllowedTardies:0,accumulationMode:'calendar_month',accumulationDays:30})]);
    }
    for(const [index,id]of people.entries()) {
      const branchId=branches[index===1||index===3?1:0];const companyId=index===2?null:index===1||index===4?alfa.id:beta.id;
      await database.query('INSERT INTO employees(id,name,first_name,branch_id,company_id) VALUES($1,$2,$2,$3,$4)',[id,['Ana','Jefa Cancún','Bruno','Otra Cancún','Zoe'][index],branchId,companyId]);
      await database.query("INSERT INTO branch_assignments(id,employee_id,branch_id,effective_from) VALUES($1,$2,$3,'2026-01-01')",[randomUUID(),id,branchId]);
    }
    await database.query('INSERT INTO employee_leave_profiles(employee_id,manager_id,vacation_balance) VALUES($1,$2,5)',[people[0],people[1]]);
    const hash=(await services.auth.repository.credentials('admin'))!.passwordHash;
    for(const [username,role,employeeId]of [['human-resources','hr',null],['boss','employee',people[1]],['employee','employee',people[0]],['other','employee',people[2]]]as const) {
      const id=randomUUID();await database.query('INSERT INTO auth_accounts(id,username,name,password_hash,role,employee_id,must_change_password) VALUES($1,$2,$2,$3,$4,$5,FALSE)',[id,username,hash,role,employeeId]);if(role==='hr')await database.query('INSERT INTO auth_account_branches VALUES($1,$2)',[id,branches[0]]);
    }
    hr=await login('human-resources');boss=await login('boss');employee=await login('employee');other=await login('other');
    await database.query("INSERT INTO devices(id,name,ip_address,branch_id,driver) VALUES($1,'Reloj','127.70.0.1',$2,'node')",[device,branches[0]]);
    await database.query("INSERT INTO device_users(id,device_id,device_user_id,employee_id,binding_status,raw_data) VALUES($1,$2,'101',$3,'active','{}')",[randomUUID(),device,people[0]]);
    for(const [date,times]of [['2026-10-16',['10:00','12:30','14:00','17:30']],['2026-10-18',['10:20','17:30']],['2026-10-19',['08:30','12:00']]]as const) for(const time of times)await database.query("INSERT INTO attendance_logs(id,device_id,event_key,user_id,occurred_at,branch_id,raw_data) VALUES($1,$2,$3,'101',$4,$5,'{}')",[randomUUID(),device,`${date}-${time}`,dateAtLocalTime(date,time,'America/Mexico_City'),branches[0]]);
    await services.evaluation.recalculate();
  },60000);
  afterAll(async()=>{await services?.app.close();await database?.close();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();}});

  it('approves an open client visit, retains real punches and removes presence penalties without fabricating work',async()=>{
    const before=await logs();expect((await card('2026-10-16')).days[0].incidents.length).toBeGreaterThan(0);
    client=await create(input('client_visit','2026-10-16',{clientName:'Cliente Nacional',fullDay:false}));
    await resolve(root,client,'approve','',403);await resolve(hr,client,'reject','No permitido',403);client=await resolve(boss,client);
    const report=await card('2026-10-16');const day=report.days[0];expect(day).toMatchObject({status:'authorized_work',incidents:[],workedMinutes:null,mealDeparture:null,mealReturn:null});
    expect(day.punches).toHaveLength(4);expect(day.punches.some((p:any)=>p.movement==='meal_departure'||p.movement==='meal_return')).toBe(false);
    expect(day.leaveAuthorizations[0]).toMatchObject({kind:'client_visit',clientName:'Cliente Nacional',fullDay:false});expect(report.summary.authorizedWorkDays).toBe(1);expect(await logs()).toEqual(before);
  });
  it('restricts rollback to RH/admin and restores the prior incidents while retaining the original approval',async()=>{
    await resolve(employee,client,'cancel','Error en fechas',403);await resolve(boss,client,'cancel','Error en fechas',403);
    client=await resolve(hr,client,'cancel','Error en fechas');expect(client.status).toBe('cancelled');
    const detail=await call(hr,'GET',`/leave-requests/${client.id}`);expect(detail.events.map((event:any)=>event.kind)).toEqual(['created','approved','cancelled']);
    expect(detail.events[2]).toMatchObject({actorAccountId:hr.id,actorEmployeeId:null,actorRole:'hr',previousStatus:'approved'});
    expect((await card('2026-10-16')).days[0].incidents.length).toBeGreaterThan(0);
    const corrected=await create(input('client_visit','2026-11-26',{clientName:'Cliente Nacional',fullDay:true,replacesRequestId:client.id}));expect(corrected).toMatchObject({status:'pending',replacesRequestId:client.id});
    await call(other,'POST','/me/leave-requests/preview',input('absence','2026-11-26',{replacesRequestId:client.id}),400);
  });
  it('shows full-day home office without office punches and never consumes vacations',async()=>{
    const request=await create(input('home_office','2026-11-17'));await resolve(boss,request);
    const report=await card('2026-11-17');expect(report.days[0]).toMatchObject({status:'authorized_work',entry:null,exit:null,workedMinutes:null,punches:[]});expect(report.summary.daysWithoutRecords).toBe(0);expect(report.summary.authorizedWorkDays).toBe(1);
    await call(employee,'POST','/me/leave-requests/preview',input('home_office','2026-11-27',{useVacation:true}),400);
    await call(employee,'POST','/me/leave-requests/preview',input('client_visit','2026-11-27',{authorizedTime:'10:00'}),400);
    await call(employee,'POST','/me/leave-requests/preview',input('home_office','2026-11-27',{fullDay:false}),400);
  });
  it('supports optional arrival and departure times without turning them into an authorized absence',async()=>{
    const arrival=await create(input('late_arrival','2026-10-18'));await resolve(boss,arrival);
    expect((await card('2026-10-18')).days[0].incidents.some((incident:any)=>incident.kind==='arrival')).toBe(false);
    const paired=await create(input('early_exit','2026-10-18'));await resolve(boss,paired);
    const departure=await create(input('early_exit','2026-10-19'));await resolve(boss,departure);
    expect((await card('2026-10-19')).days[0]).toMatchObject({exit:'2026-10-19T18:00:00.000Z',unauthorizedEarlyExitMinutes:0,earlyExitMinutes:330});
    const empty=await create(input('late_arrival','2026-11-20'));await resolve(boss,empty);expect((await card('2026-11-20')).days[0].status).not.toBe('authorized_absence');
    const pending=await create(input('absence','2026-11-28'));await resolve(employee,pending,'cancel','Ya no se requiere');
  });
  it('refunds vacation exactly once during concurrent administrative cancellation',async()=>{
    let request=await create(input('absence','2026-11-24',{useVacation:true}));request=await resolve(boss,request);
    expect((await database.query('SELECT vacation_balance FROM employee_leave_profiles WHERE employee_id=$1',[people[0]])).rows[0].vacation_balance).toBe(4);
    const options=(session:Session)=>({method:'POST' as const,url:`/leave-requests/${request.id}/resolve`,headers:{origin,cookie:session.cookie,'x-csrf-token':session.csrf},payload:{action:'cancel',expectedVersion:request.version,comments:'Error en fechas'}});
    const results=await Promise.all([services.app.inject(options(root)),services.app.inject(options(hr))]);expect(results.map(result=>result.statusCode).sort()).toEqual([200,409]);cancelledVacation=results.find(result=>result.statusCode===200)!.json();
    expect((await database.query('SELECT vacation_balance FROM employee_leave_profiles WHERE employee_id=$1',[people[0]])).rows[0].vacation_balance).toBe(5);
    expect((await database.query("SELECT COUNT(*)::int AS count FROM vacation_movements WHERE request_id=$1 AND kind='return'",[request.id])).rows[0].count).toBe(1);
    const corrected=await create(input('absence','2026-11-25',{useVacation:true,replacesRequestId:request.id}));expect(corrected.status).toBe('pending');
  });
  it('rolls back administrative cancellation if recalculation fails',async()=>{
    let request=await create(input('absence','2026-11-29',{useVacation:true}));request=await resolve(boss,request);
    const stored=(await services.auth.repository.credentials('human-resources'))!;
    const service=new ManageLeave(new PrismaLeaveRepository(database,async()=>{throw new Error('Forced recalculation failure')}),value=>value);
    await expect(service.resolve(request.id,{action:'cancel',expectedVersion:request.version,comments:'Corregir fechas'},{...stored,sessionHash:'test',csrfToken:'test'})).rejects.toThrow('Forced recalculation failure');
    expect((await call(hr,'GET',`/leave-requests/${request.id}`)).request.status).toBe('approved');
    expect((await database.query("SELECT COUNT(*)::int AS count FROM vacation_movements WHERE request_id=$1 AND kind='return'",[request.id])).rows[0].count).toBe(0);
  });
  it('lists bulk-assignment candidates with company labels, filters, ordering and branch isolation',async()=>{
    const list=await call(hr,'GET',`/companies/${alfa.id}/employees?sortBy=company&sortOrder=asc`);expect(list.total).toBe(3);expect(list.employees.map((person:any)=>person.name)).toEqual(['Zoe','Ana','Bruno']);
    const unassigned=await call(hr,'GET',`/companies/${alfa.id}/employees?companyId=unassigned`);expect(unassigned.employees.map((person:any)=>person.id)).toEqual([people[2]]);
    const searched=await call(hr,'GET',`/companies/${alfa.id}/employees?search=101`);expect(searched.employees.map((person:any)=>person.id)).toEqual([people[0]]);
    await call(boss,'GET',`/companies/${alfa.id}/employees`,undefined,403);await call(hr,'GET',`/companies/${alfa.id}/employees?branchId=${branches[1]}`,undefined,403);
    const sorted=await call(hr,'GET',`/employees?branchId=${branches[0]}&sortBy=name&sortOrder=desc`);expect(sorted.map((person:any)=>person.name)).toEqual(['Zoe','Bruno','Ana']);
  });
  it('reassigns selected employees atomically, preserving unselected records and rejecting stale or foreign selections',async()=>{
    const before=await logs();const payload={expectedVersion:alfa.version,assignments:[{employeeId:people[0],expectedCompanyId:beta.id},{employeeId:people[2],expectedCompanyId:null}]};
    await call(employee,'POST',`/companies/${alfa.id}/employees`,payload,403);
    await call(hr,'POST',`/companies/${alfa.id}/employees`,{...payload,assignments:[payload.assignments[0],{employeeId:people[3],expectedCompanyId:beta.id}]},403);
    await call(hr,'POST',`/companies/${alfa.id}/employees`,{...payload,assignments:[{employeeId:people[0],expectedCompanyId:null},payload.assignments[1]]},409);
    expect((await database.query('SELECT company_id FROM employees WHERE id=$1',[people[2]])).rows[0].company_id).toBeNull();
    expect((await call(hr,'POST',`/companies/${alfa.id}/employees`,payload)).assigned).toBe(2);
    expect((await database.query('SELECT company_id FROM employees WHERE id=$1',[people[3]])).rows[0].company_id).toBe(beta.id);expect(await logs()).toEqual(before);
    expect((await call(employee,'GET','/me/profile')).companyName).toBe('Alfa');
    expect((await call(hr,'GET',`/leave-requests/${cancelledVacation.id}`)).request.status).toBe('cancelled');
  });
});
