import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/main.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import type { AccountRole } from '../src/domain/entities/auth.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;
integration('authenticated panel and branch isolation', () => {
  const schema = `test_auth_${randomUUID().replaceAll('-', '')}`;
  const password = 'Secure test password 2026!';
  const origin = 'http://127.0.0.1:5173';
  const branches = [randomUUID(),randomUUID(),randomUUID()];
  const employees = [randomUUID(),randomUUID(),randomUUID()];
  const devices = [randomUUID(),randomUUID(),randomUUID()];
  const clockRecords = [randomUUID(),randomUUID(),randomUUID()];
  let admin: Database; let database: Database; let services: Awaited<ReturnType<typeof buildApp>>;
  let address = 1;
  let rootId: string;
  type Session = { cookie: string; csrf: string; id: string };
  let root: Session; let hr: Session; let manager: Session;

  async function login(username: string) {
    const response = await services.app.inject({ method: 'POST',url: '/auth/login',remoteAddress: `127.0.0.${address++}`,headers: { origin },payload: { username,password } });
    expect(response.statusCode,response.body).toBe(204);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Strict');
    const me = await services.app.inject({ method: 'GET',url: '/auth/me',headers: { cookie } });
    expect(me.statusCode,me.body).toBe(200);
    expect(me.body).not.toContain('sessionHash');
    return { cookie,csrf: me.json().csrfToken,id: me.json().id };
  }
  async function call(session: Session, method: 'GET'|'POST'|'PATCH'|'PUT'|'DELETE', url: string, payload?: object, expected = 200) {
    const response = await services.app.inject({ method,url,headers: { origin,cookie: session.cookie,'x-csrf-token': session.csrf },payload });
    expect(response.statusCode,response.body).toBe(expected);
    return response.body ? response.json() : null;
  }
  async function account(username: string, role: AccountRole, branchIds: string[], forced = false) {
    const hash = (await services.auth.repository.credentials('admin'))!.passwordHash;
    const id = randomUUID();
    await database.query('INSERT INTO auth_accounts(id,username,name,password_hash,role,must_change_password) VALUES($1,$2,$2,$3,$4,$5)',[id,username,hash,role,forced]);
    for (const branch of branchIds) await database.query('INSERT INTO auth_account_branches VALUES($1,$2)',[id,branch]);
    return id;
  }

  beforeAll(async () => {
    admin = new Database(connection!); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection!); url.searchParams.set('options',`-c search_path=${schema}`);
    database = new Database(url.toString()); await runMigrations(database);
    services = await buildApp({ database });
    rootId = (await services.auth.save(null,{ username: 'admin',name: 'Administrador',role: 'admin',branchIds: [],isActive: true },password)).id;
    await database.query('UPDATE auth_accounts SET must_change_password=FALSE WHERE id=$1',[rootId]);
    for (const [index,branch] of branches.entries()) {
      await database.query('INSERT INTO branches(id,name) VALUES($1,$2)',[branch,`Branch ${index}`]);
      await database.query('INSERT INTO employees(id,name,branch_id) VALUES($1,$2,$3)',[employees[index],index ? `A other ${index}` : 'Z authorized',branch]);
      await database.query("INSERT INTO branch_assignments(id,employee_id,branch_id,effective_from) VALUES($1,$2,$3,'1900-01-01')",[randomUUID(),employees[index],branch]);
      await database.query('INSERT INTO devices(id,name,ip_address,driver,branch_id) VALUES($1,$2,$3,\'node\',$4)',[devices[index],`Clock ${index}`,`127.0.0.${index+10}`,branch]);
      await database.query("INSERT INTO device_users(id,device_id,device_user_id,employee_id,binding_status,raw_data) VALUES($1,$2,'1',$3,'active','{}')",[clockRecords[index],devices[index],employees[index]]);
      await database.query("INSERT INTO attendance_logs(id,device_id,event_key,user_id,occurred_at,branch_id,raw_data) VALUES($1::uuid,$2,$1::text,'1','2026-11-05T14:30:00Z',$3,'{}')",[randomUUID(),devices[index],branch]);
      await database.query("INSERT INTO device_user_photos(device_id,device_user_id,content_type,image_data) VALUES($1,'1','image/jpeg',$2)",[devices[index],Buffer.from([255,216,255,217])]);
      await database.query("INSERT INTO work_schedules(id,branch_id,name,effective_from,is_default,settings) VALUES($1,$2,'Schedule','2026-01-01',TRUE,$3::jsonb)",
        [randomUUID(),branch,JSON.stringify({workDays:[1,2,3,4,5],entryTime:'08:30',exitTime:'17:30',mealEnabled:false,mealStart:'13:00',mealEnd:'14:00',mealDurationMinutes:60,recognitionMarginMinutes:30})]);
    }
    await services.evaluation.recalculate();
    await account('human-resources','hr',branches.slice(0,2));
    await account('branch-manager','manager',[branches[0]]);
    root = await login('admin'); hr = await login('human-resources'); manager = await login('branch-manager');
  },60000);
  afterAll(async () => { await services?.app.close(); await database?.close(); if(admin){ await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); } });

  it('requires authentication for data, photos, reports and API documentation',async () => {
    for(const url of ['/employees','/branches','/devices','/docs',`/devices/${devices[0]}/users/1/photo`,`/attendance/cards/export?branchId=${branches[0]}&employeeStatus=active&from=2026-11-05&to=2026-11-05`]) {
      expect((await services.app.inject({method:'GET',url})).statusCode).toBe(401);
    }
    expect((await services.app.inject({method:'GET',url:'/health'})).statusCode).toBe(200);
  });
  it('stores Argon2id passwords and hashed session tokens without returning credentials',async () => {
    const stored = await services.auth.repository.credentials('admin');
    expect(stored!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const rows = (await database.query('SELECT token_hash FROM auth_sessions WHERE account_id=$1',[root.id])).rows;
    expect(rows[0].token_hash).not.toBe(root.cookie.split('=')[1]);
    const response = await call(root,'GET','/auth/accounts');
    expect(JSON.stringify(response)).not.toContain('password');
  });
  it('rejects cross-origin login and invalid credentials',async () => {
    expect((await services.app.inject({method:'POST',url:'/auth/login',headers:{origin:'https://attacker.example'},payload:{username:'admin',password}})).statusCode).toBe(403);
    expect((await services.app.inject({method:'POST',url:'/auth/login',headers:{origin},payload:{username:'admin',password:'incorrect'}})).statusCode).toBe(401);
  });
  it('filters before limits and isolates simultaneous single-branch, multibranch and admin reads',async () => {
    for(let index=0;index<4;index++) {
      const [one,two,all] = await Promise.all([call(manager,'GET','/employees?limit=1'),call(hr,'GET','/employees?limit=500'),call(root,'GET','/employees?limit=500')]);
      expect(one.map((item:any)=>item.id)).toEqual([employees[0]]);
      expect(new Set(two.map((item:any)=>item.branchId))).toEqual(new Set(branches.slice(0,2)));
      expect(all).toHaveLength(3);
    }
    expect((await call(manager,'GET','/branches')).map((item:any)=>item.id)).toEqual([branches[0]]);
    expect((await call(hr,'GET','/devices'))).toHaveLength(2);
    expect((await call(manager,'GET','/attendance?limit=1'))[0].branchId).toBe(branches[0]);
    expect(await call(manager,'GET','/users?limit=500')).toHaveLength(1);
  });
  it('blocks guessed IDs, other branches, photos and full export endpoints',async () => {
    for(const url of [`/employees/${employees[1]}`,`/employees/${employees[1]}/attendance?from=2026-11-05&to=2026-11-05`,
      `/devices/${devices[1]}/users/1/photo`,`/users?deviceId=${devices[1]}`,`/attendance/daily?from=2026-11-05&to=2026-11-05&branchId=${branches[1]}`,
      `/attendance/cards/export?branchId=${branches[1]}&employeeStatus=active&from=2026-11-05&to=2026-11-05`,
      `/attendance/overtime/export?branchId=${branches[1]}&employeeStatus=active&from=2026-11-05&to=2026-11-05`]) await call(manager,'GET',url,undefined,403);
    const own = await call(manager,'GET',`/attendance/cards/export?branchId=${branches[0]}&employeeStatus=active&from=2026-11-05&to=2026-11-05`);
    expect(own.totalEmployees).toBe(1);
    expect(JSON.stringify(own)).not.toContain(employees[1]);
  });
  it('enforces roles, CSRF, origin and both sides of transfers',async () => {
    await call(manager,'PATCH',`/employees/${employees[0]}`,{firstName:'Forbidden'},403);
    await call(hr,'POST','/auth/accounts',{username:'forbidden'},403);
    await call(hr,'POST',`/devices/${devices[0]}/clock-time/synchronize`,{},403);
    await call(hr,'POST','/organization/assignments',{employeeIds:[employees[0]],deviceUserIds:[],branchId:branches[2],effectiveFrom:'2026-11-05'},403);
    await call(hr,'POST','/organization/assignments',{employeeIds:[employees[2]],deviceUserIds:[],branchId:branches[0],effectiveFrom:'2026-11-05'},403);
    const missingCsrf = await services.app.inject({method:'PATCH',url:`/employees/${employees[0]}`,headers:{origin,cookie:hr.cookie},payload:{firstName:'Forbidden'}});
    expect(missingCsrf.statusCode).toBe(403);
    const crossOrigin = await services.app.inject({method:'PATCH',url:`/employees/${employees[0]}`,headers:{origin:'https://attacker.example',cookie:hr.cookie,'x-csrf-token':hr.csrf},payload:{firstName:'Forbidden'}});
    expect(crossOrigin.statusCode).toBe(403);
    expect((await database.query('SELECT name FROM employees WHERE id=$1',[employees[0]])).rows[0].name).toBe('Z authorized');
  });
  it('scopes leave totals and decisions and records the authenticated account atomically',async () => {
    for (const [index,boss] of [[0,1],[1,2]]) await call(root,'PUT',`/employees/${employees[index]}/leave-profile`,
      {managerId:employees[boss],whatsappPhone:null,vacationBalance:5,expectedVersion:0,adjustmentReason:'Initial balance'},200);
    const requests = [];
    for(const employeeId of employees.slice(0,2)) {
      const input = {employeeId,kind:'absence',from:'2026-11-06',to:'2026-11-06',authorizedTime:null,paid:true,useVacation:true,reason:'Test vacation'};
      const preview = await call(root,'POST','/leave-requests/preview',input);
      requests.push(await call(root,'POST','/leave-requests',{input,previewToken:preview.token,sourceKey:randomUUID()},201));
    }
    const result = await call(manager,'GET','/leave-requests?from=2026-11-01&to=2026-11-30&limit=1');
    expect(result.total).toBe(1); expect(result.requests[0].id).toBe(requests[0].id);
    await call(manager,'GET',`/leave-requests/${requests[1].id}`,undefined,403);
    await call(manager,'POST',`/leave-requests/${requests[0].id}/resolve`,{action:'approve',expectedVersion:1,actorEmployeeId:employees[2]},400);
    await call(manager,'POST',`/leave-requests/${requests[0].id}/resolve`,{action:'approve',expectedVersion:1,actorEmployeeId:employees[1]});
    const event = (await database.query("SELECT actor_account_id FROM leave_request_events WHERE request_id=$1 AND kind='approved'",[requests[0].id])).rows[0];
    const movement = (await database.query("SELECT actor_account_id FROM vacation_movements WHERE request_id=$1 AND kind='consumption'",[requests[0].id])).rows[0];
    expect(event.actor_account_id).toBe(manager.id); expect(movement.actor_account_id).toBe(manager.id);
    const detail = await call(manager,'GET',`/leave-requests/${requests[0].id}`);
    expect(detail.events.find((event:any)=>event.kind==='approved').actorAccountName).toBe('branch-manager');
  });
  it('keeps historical attendance outside assigned branches protected',async () => {
    await database.query("INSERT INTO branch_assignments(id,employee_id,branch_id,effective_from) VALUES($1,$2,$3,'2025-01-01')",[randomUUID(),employees[0],branches[2]]);
    await database.query("UPDATE branch_assignments SET effective_from='2026-01-01' WHERE employee_id=$1 AND effective_from='1900-01-01'",[employees[0]]);
    await call(manager,'GET',`/employees/${employees[0]}/attendance?from=2025-12-01&to=2025-12-02`,undefined,403);
    await call(manager,'GET',`/employees/${employees[0]}/history`,undefined,403);
    await call(manager,'GET',`/employees/${employees[0]}/attendance?from=2026-11-05&to=2026-11-05`);
  });
  it('forces initial password changes and revokes all old sessions after changing passwords',async () => {
    await account('new-user','hr',[branches[0]],true);
    const forced = await login('new-user');
    await call(forced,'GET','/employees',undefined,403);
    await call(forced,'POST','/auth/change-password',{currentPassword:password,newPassword:'Changed test password 2026!'},204);
    await call(forced,'GET','/auth/me',undefined,401);
    expect((await services.auth.repository.credentials('new-user'))!.mustChangePassword).toBe(false);
  },30000);
  it('revokes access immediately when accounts or branch grants change',async () => {
    await account('restricted-user','hr',[branches[0]]);
    const session = await login('restricted-user');
    const current = (await services.auth.repository.list()).find(account=>account.id===session.id)!;
    await call(root,'PATCH',`/auth/accounts/${session.id}`,{username:current.username,name:current.name,role:current.role,isActive:true,branchIds:[branches[1]],expectedVersion:current.version});
    await call(session,'GET','/employees',undefined,401);
    const fresh = await login('restricted-user');
    expect((await call(fresh,'GET','/employees'))[0].id).toBe(employees[1]);
    const updated = (await services.auth.repository.list()).find(account=>account.id===session.id)!;
    await call(root,'PATCH',`/auth/accounts/${session.id}`,{username:updated.username,name:updated.name,role:updated.role,isActive:false,branchIds:updated.branchIds,expectedVersion:updated.version});
    await call(fresh,'GET','/employees',undefined,401);
  });
  it('protects the last administrator and serializes conflicting account changes',async () => {
    await call(root,'PATCH',`/auth/accounts/${rootId}`,{username:'admin',name:'Administrador',role:'admin',isActive:false,branchIds:[],expectedVersion:1},400);
    const current = (await services.auth.repository.list()).find(account=>account.id===manager.id)!;
    const results = await Promise.all([0,1].map(()=>services.app.inject({method:'PATCH',url:`/auth/accounts/${manager.id}`,headers:{origin,cookie:root.cookie,'x-csrf-token':root.csrf},payload:{username:current.username,name:current.name,role:current.role,isActive:true,branchIds:current.branchIds,expectedVersion:current.version}})));
    expect(results.map(result=>result.statusCode).sort()).toEqual([200,409]);
  });
  it('audits actual accounts and logs out with server-side revocation',async () => {
    const session = await login('human-resources');
    await call(session,'PATCH',`/employees/${employees[1]}`,{position:'Audited role'},204);
    const audit = await call(root,'GET','/auth/audit');
    expect(audit.some((entry:any)=>entry.accountId===session.id&&entry.action==='operation'&&entry.metadata.route==='/employees/:id')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(password);
    await call(session,'POST','/auth/logout',{},204);
    await call(session,'GET','/auth/me',undefined,401);
  });
  it('limits repeated login attempts',async () => {
    for(let index=0;index<5;index++) expect((await services.app.inject({method:'POST',url:'/auth/login',remoteAddress:'127.0.0.240',headers:{origin},payload:{username:'missing-user',password:'wrong'}})).statusCode).toBe(401);
    expect((await services.app.inject({method:'POST',url:'/auth/login',remoteAddress:'127.0.0.240',headers:{origin},payload:{username:'missing-user',password:'wrong'}})).statusCode).toBe(429);
  },30000);
});
