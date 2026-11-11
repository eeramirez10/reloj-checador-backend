import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { buildApp } from '../src/main.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { dateAtLocalTime } from '../src/domain/entities/local-date.js';
import type { Company } from '../src/domain/entities/company.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;
integration('company classification, permissions and report snapshots',() => {
  const schema = `test_companies_${randomUUID().replaceAll('-','')}`;
  const branches = [randomUUID(),randomUUID()];
  const employees = Array.from({length:9},() => randomUUID());
  const devices = [randomUUID(),randomUUID()];
  const origin = 'http://127.0.0.1:5173';
  const password = 'Company test password 2026!';
  const date = '2026-11-09';
  let admin: Database; let database: Database; let services: Awaited<ReturnType<typeof buildApp>>;
  let companyA: Company; let companyB: Company;
  type Session = { cookie: string; csrf: string };
  let root: Session; let hr: Session; let manager: Session; let employee: Session;
  async function login(username: string) {
    const response = await services.app.inject({method:'POST',url:'/auth/login',headers:{origin},payload:{username,password}});
    expect(response.statusCode,response.body).toBe(204);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    const me = await services.app.inject({method:'GET',url:'/auth/me',headers:{cookie}});
    return {cookie,csrf:me.json().csrfToken};
  }
  async function call(session: Session,method: 'GET'|'POST'|'PATCH'|'PUT',url: string,payload?: object,status=200) {
    const response = await services.app.inject({method,url,headers:{origin,cookie:session.cookie,'x-csrf-token':session.csrf},payload});
    expect(response.statusCode,response.body).toBe(status);
    return response.body ? response.json() : null;
  }
  const reportQuery = (companyId?: string) => `branchId=${branches[0]}&employeeStatus=active&from=${date}&to=${date}${companyId ? `&companyId=${companyId}` : ''}`;
  async function originalAttendance() {
    const result:Record<string,unknown> = {};
    for (const table of ['attendance_logs','attendance_evaluations','attendance_incidents','attendance_deductions','device_users','branch_assignments']) {
      result[table] = (await database.query(`SELECT to_jsonb(t) AS record FROM ${table} t ORDER BY t.id`)).rows;
    }
    return result;
  }
  beforeAll(async () => {
    admin = new Database(connection!); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection!);url.searchParams.set('options',`-c search_path=${schema}`);
    database = new Database(url.toString());await runMigrations(database);
    services = await buildApp({database});
    const account = await services.auth.save(null,{username:'admin',name:'Admin',role:'admin',branchIds:[],isActive:true},password);
    await database.query('UPDATE auth_accounts SET must_change_password=FALSE WHERE id=$1',[account.id]);
    root = await login('admin');
    companyA = await call(root,'POST','/companies',{name:'Empresa A',code:'A',active:true,notes:'Clasificación A'},201);
    companyB = await call(root,'POST','/companies',{name:'Empresa B',code:'B',active:true,notes:''},201);
    for(const [index,id] of branches.entries()) {
      await database.query('INSERT INTO branches(id,name) VALUES($1,$2)',[id,index ? 'Cancún' : 'México']);
      await database.query(`INSERT INTO work_schedules(id,branch_id,name,effective_from,is_default,settings) VALUES($1,$2,'Jornada','2026-01-01',TRUE,$3::jsonb)`,
        [randomUUID(),id,JSON.stringify({workDays:[1,2,3,4,5],entryTime:'08:30',exitTime:'17:30',mealEnabled:false,mealStart:'00:00',mealEnd:'00:00',mealDurationMinutes:60})]);
      await database.query(`INSERT INTO branch_policies(id,branch_id,effective_from,settings) VALUES($1,$2,'2026-01-01',$3::jsonb)`,
        [randomUUID(),id,JSON.stringify({entryToleranceMinutes:0,mealToleranceMinutes:0,entryAllowedTardies:0,mealAllowedTardies:0,accumulationMode:'calendar_month',accumulationDays:30,overtimeEntryMarginMinutes:0,overtimeExitMarginMinutes:0})]);
      await database.query("INSERT INTO devices(id,name,ip_address,branch_id,driver) VALUES($1,'Reloj',$2,$3,'node')",[devices[index],`127.10.0.${index+1}`,id]);
    }
    for(const [index,id] of employees.entries()) {
      const branchIndex = index===8 ? 1 : 0;
      const companyId = index < 6 || index===8 ? companyA.id : index===6 ? companyB.id : null;
      await database.query('INSERT INTO employees(id,name,first_name,branch_id,company_id) VALUES($1,$2,$2,$3,$4)',[id,`Person ${index}`,branches[branchIndex],companyId]);
      await database.query("INSERT INTO branch_assignments(id,employee_id,branch_id,effective_from) VALUES($1,$2,$3,'2026-01-01')",[randomUUID(),id,branches[branchIndex]]);
      await database.query("INSERT INTO device_users(id,device_id,device_user_id,employee_id,binding_status,raw_data) VALUES($1,$2,$3,$4,'active','{}')",[randomUUID(),devices[branchIndex],String(index+1),id]);
      await database.query(`INSERT INTO employee_schedule_versions(id,employee_id,effective_from,work_hours,meal,meal_mode,recognition_margin_minutes,overtime_settings)
        VALUES($1,$2,'2026-01-01',NULL,NULL,'inherit',30,$3::jsonb)`,[randomUUID(),id,JSON.stringify({enabled:true,workMode:'daily',restEnabled:false,dailyRest:null,additionalRestMinutes:0})]);
      for(const time of ['09:00','18:30']) await database.query(`INSERT INTO attendance_logs(id,device_id,event_key,user_id,occurred_at,branch_id,raw_data)
        VALUES($1,$2,$3,$4,$5,$6,'{}')`,[randomUUID(),devices[branchIndex],`${index}-${time}`,String(index+1),dateAtLocalTime(date,time,'America/Mexico_City'),branches[branchIndex]]);
    }
    await services.evaluation.recalculate();
    const hash = (await services.auth.repository.credentials('admin'))!.passwordHash;
    for(const [username,role,employeeId] of [['human-resources','hr',null],['manager','manager',null],['employee','employee',employees[0]]] as const) {
      const id = randomUUID();
      await database.query('INSERT INTO auth_accounts(id,username,name,password_hash,role,employee_id,must_change_password) VALUES($1,$2,$2,$3,$4,$5,FALSE)',[id,username,hash,role,employeeId]);
      if(role!=='employee') await database.query('INSERT INTO auth_account_branches VALUES($1,$2)',[id,branches[0]]);
    }
    hr = await login('human-resources');manager = await login('manager');employee = await login('employee');
  },60000);
  afterAll(async () => {await services?.app.close();await database?.close();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();}});

  it('restricts catalog management to admin and validates duplicates and optimistic versions',async () => {
    await call(hr,'GET','/companies');await call(manager,'GET','/companies');await call(employee,'GET','/companies',undefined,403);
    await call(hr,'POST','/companies',{name:'Forbidden'},403);
    await call(manager,'PATCH',`/companies/${companyA.id}`,{...companyA,expectedVersion:1},403);
    await call(root,'POST','/companies',{name:' empresa a ',code:'X'},409);
    await call(root,'POST','/companies',{name:'Otra',code:'a'},409);
    const updated = await call(root,'PATCH',`/companies/${companyA.id}`,{name:companyA.name,code:companyA.code,active:true,notes:'Actualizada',expectedVersion:companyA.version});
    await call(root,'PATCH',`/companies/${companyA.id}`,{name:companyA.name,code:companyA.code,active:true,notes:'Conflicto',expectedVersion:companyA.version},409);
    companyA = updated;
  });
  it('applies company and branch filters before list limits without widening branch permissions',async () => {
    expect((await call(hr,'GET',`/employees?branchId=${branches[0]}&companyId=${companyA.id}&limit=1`))).toHaveLength(1);
    const all = await call(hr,'GET',`/employees?branchId=${branches[0]}&companyId=${companyA.id}&limit=500`);
    expect(all).toHaveLength(6);expect(all.every((row:any)=>row.companyId===companyA.id)).toBe(true);
    expect((await call(root,'GET',`/employees?companyId=${companyA.id}&limit=500`))).toHaveLength(7);
    const none = await call(hr,'GET',`/employees?branchId=${branches[0]}&companyId=unassigned`);
    expect(none.map((row:any)=>row.id)).toEqual([employees[7]]);
    expect(await call(root,'GET','/employees?branchId=unassigned')).toEqual([]);
    await call(hr,'GET',`/employees?branchId=${branches[1]}&companyId=${companyA.id}`,undefined,403);
    await call(hr,'GET','/employees?companyId=invalid',undefined,400);
  });
  it('filters card pagination and complete exports using the same read-only selection',async () => {
    const before = await originalAttendance();
    const first = await call(manager,'GET',`/attendance/cards?${reportQuery(companyA.id)}&limit=5&page=1`);
    const second = await call(manager,'GET',`/attendance/cards?${reportQuery(companyA.id)}&limit=5&page=2`);
    const exported = await call(manager,'GET',`/attendance/cards/export?${reportQuery(companyA.id)}`);
    expect(first).toMatchObject({totalEmployees:6,totalPages:2,companyFilter:{id:companyA.id,name:companyA.name}});
    expect(first.cards).toHaveLength(5);expect(second.cards).toHaveLength(1);expect(exported.cards).toHaveLength(6);
    expect(exported.cards.map((card:any)=>card.employee.id)).toEqual([...first.cards,...second.cards].map((card:any)=>card.employee.id));
    expect((await call(hr,'GET',`/attendance/cards/export?${reportQuery('unassigned')}`)).cards[0].employee.id).toBe(employees[7]);
    expect((await call(hr,'GET',`/attendance/cards/export?${reportQuery()}`)).totalEmployees).toBe(8);
    await call(hr,'GET',`/attendance/cards/export?${reportQuery(companyA.id).replace(branches[0],branches[1])}`,undefined,403);
    expect(await originalAttendance()).toEqual(before);
  });
  it('filters overtime employees and aggregate totals before pagination and exports',async () => {
    const first = await call(hr,'GET',`/attendance/overtime?${reportQuery(companyA.id)}&limit=5&page=1`);
    const second = await call(hr,'GET',`/attendance/overtime?${reportQuery(companyA.id)}&limit=5&page=2`);
    const exported = await call(hr,'GET',`/attendance/overtime/export?${reportQuery(companyA.id)}`);
    expect(first.totalEmployees).toBe(6);expect(first.employees).toHaveLength(5);expect(second.employees).toHaveLength(1);
    expect(exported.employees).toHaveLength(6);expect(exported.totals).toEqual(first.totals);expect(second.totals).toEqual(first.totals);
    expect(exported.totals.netSeconds).toBe(exported.employees.reduce((sum:number,row:any)=>sum+row.totals.netSeconds,0));
    expect(exported.totals.netSeconds).toBeGreaterThan(0);
  });
  it('returns current company labels in daily attendance and deductions without changing original evaluations',async () => {
    const before = await originalAttendance();
    const query = `from=${date}&to=${date}&branchId=${branches[0]}&companyId=${companyB.id}`;
    const days = await call(hr,'GET',`/attendance/daily?${query}`);
    expect(days).toHaveLength(1);expect(days[0]).toMatchObject({employeeId:employees[6],companyId:companyB.id,companyName:companyB.name});
    const deductions = await call(hr,'GET',`/attendance/deductions?${query}`);
    expect(deductions.length).toBeGreaterThan(0);expect(deductions.every((row:any)=>row.companyId===companyB.id)).toBe(true);
    await call(hr,'PATCH',`/employees/${employees[6]}`,{companyId:companyA.id},204);
    expect(await call(hr,'GET',`/attendance/daily?${query}`)).toEqual([]);
    expect((await call(hr,'GET',`/attendance/daily?${query.replace(companyB.id,companyA.id)}`))).toHaveLength(7);
    expect(await originalAttendance()).toEqual(before);
    await call(hr,'PATCH',`/employees/${employees[6]}`,{companyId:companyB.id},204);
  });
  it('creates and updates company links atomically and keeps inactive links readable',async () => {
    const created = await call(hr,'POST','/employees',{firstName:'Alta manual',branchId:branches[0],companyId:companyA.id},201);
    expect(created.companyName).toBe(companyA.name);
    await call(hr,'PATCH',`/employees/${created.id}`,{firstName:'No guardar',companyId:randomUUID()},400);
    expect((await call(root,'GET',`/employees/${created.id}`)).firstName).toBe('Alta manual');
    await call(hr,'PATCH',`/employees/${employees[8]}`,{companyId:companyB.id},403);
    await call(employee,'PATCH',`/employees/${employees[0]}`,{companyId:companyB.id},403);
    await call(employee,'PUT','/me/contact',{whatsappPhone:null,alternatePhone:null,bloodType:null,expectedVersion:0,companyId:companyB.id},400);
    expect((await call(employee,'GET','/me/profile')).companyName).toBe(companyA.name);
    companyA = await call(root,'PATCH',`/companies/${companyA.id}`,{name:companyA.name,code:companyA.code,active:false,notes:companyA.notes,expectedVersion:companyA.version});
    await call(hr,'POST','/employees',{firstName:'Inactiva',branchId:branches[0],companyId:companyA.id},400);
    await call(hr,'PATCH',`/employees/${employees[7]}`,{companyId:companyA.id},400);
    await call(hr,'PATCH',`/employees/${employees[0]}`,{companyId:companyA.id},204);
    expect((await call(hr,'GET',`/attendance/cards/export?${reportQuery(companyA.id)}`)).totalEmployees).toBe(7);
    await call(hr,'PATCH',`/employees/${created.id}`,{companyId:null},204);
    expect((await call(root,'GET',`/employees/${created.id}`)).companyId).toBeNull();
  });
  it('preserves confirmed company classification when reimporting external employee codes',async () => {
    await services.employees.upsert({employeeNumber:'00000999',normalizedEmployeeNumber:'999',name:'Importado',companyCode:'00001'});
    const person = (await services.employees.list({search:'00000999',limit:1}))[0];
    await call(root,'PATCH',`/employees/${person.id}`,{companyId:companyB.id},204);
    await services.employees.upsert({employeeNumber:'00000999',normalizedEmployeeNumber:'999',name:'Importado',companyCode:'99999'});
    expect((await services.employees.findById(person.id))!.companyId).toBe(companyB.id);
  });
  it('preserves a company when identifying a pending employee and rejects conflicting classifications',async () => {
    const source = randomUUID();
    await database.query("INSERT INTO employees(id,name,branch_id,company_id,identification_status) VALUES($1,'Pendiente',$2,$3,'pending')",[source,branches[0],companyB.id]);
    await call(root,'POST',`/employees/${source}/identify`,{targetEmployeeId:employees[0]},400);
    expect((await services.employees.findById(source))!.identificationStatus).toBe('pending');
    const target = await call(root,'POST','/employees',{firstName:'Identificado',branchId:branches[0]},201);
    await call(root,'POST',`/employees/${source}/identify`,{targetEmployeeId:target.id});
    const updated = await call(root,'GET',`/employees/${target.id}`);
    expect(updated.companyId).toBe(companyB.id);expect(updated.id).toBe(target.id);
  });
});
