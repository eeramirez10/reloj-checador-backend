import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { buildApp } from '../src/main.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { EmailContentCipher } from '../src/infrastructure/integrations/email-content-cipher.js';
import { EmailWorker } from '../src/infrastructure/jobs/email-worker.js';
import { EmailSendError } from '../src/domain/datasources/email-gateway.js';
import { ManageLeave } from '../src/domain/use-cases/manage-leave.js';
import { PrismaLeaveRepository } from '../src/infrastructure/repositories/leave-repository.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;
integration('employee portal, trusted approvals and encrypted onboarding', () => {
  const schema = `test_portal_${randomUUID().replaceAll('-','')}`;
  const origin = 'http://127.0.0.1:5173';
  const key = 'ab'.repeat(32);
  const branches = [randomUUID(),randomUUID(),randomUUID()];
  const employees = [randomUUID(),randomUUID(),randomUUID()];
  const password = 'Portal test password 2026!';
  let admin: Database; let database: Database; let services: Awaited<ReturnType<typeof buildApp>>;
  let address = 20;
  type Session = { cookie: string; csrf: string; id: string };
  let root: Session; let hr: Session; let boss: Session; let employee: Session;
  let leaveId: string;
  async function login(username: string, value = password) {
    const response = await services.app.inject({ method: 'POST',url: '/auth/login',remoteAddress: `127.0.1.${address++}`,headers: { origin },payload: { username,password: value } });
    expect(response.statusCode,response.body).toBe(204);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    const me = await services.app.inject({ method: 'GET',url: '/auth/me',headers: { cookie } });
    expect(me.statusCode,me.body).toBe(200);
    return { cookie,csrf: me.json().csrfToken,id: me.json().id };
  }
  async function call(session: Session, method: 'GET'|'POST'|'PUT'|'PATCH',url: string,payload?: object,status = 200) {
    const response = await services.app.inject({ method,url,headers: { origin,cookie: session.cookie,'x-csrf-token': session.csrf },payload });
    expect(response.statusCode,response.body).toBe(status);
    return response.body ? response.json() : null;
  }
  async function createLeave(date: string, useVacation = false) {
    const input = { employeeId: employees[2],kind: 'absence',from: date,to: date,authorizedTime: null,paid: true,useVacation,reason: 'Asunto personal' };
    const preview = await call(employee,'POST','/me/leave-requests/preview',input);
    expect(preview.input.employeeId).toBe(employees[0]);
    return call(employee,'POST','/me/leave-requests',{ input,previewToken: preview.token,sourceKey: randomUUID() },201);
  }
  beforeAll(async () => {
    admin = new Database(connection!); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection!); url.searchParams.set('options',`-c search_path=${schema}`);
    database = new Database(url.toString()); await runMigrations(database);
    services = await buildApp({ database,email: { settings: { enabled: false,encryptionKey: key,publicUrl: 'http://example.test:8080/reloj/' } } });
    const account = await services.auth.save(null,{ username: 'admin',name: 'Admin',role: 'admin',branchIds: [],isActive: true },password);
    await database.query('UPDATE auth_accounts SET must_change_password=FALSE WHERE id=$1',[account.id]);
    for (const [index,id] of branches.entries()) {
      await database.query('INSERT INTO branches(id,name) VALUES($1,$2)',[id,`Branch ${index}`]);
      await database.query('INSERT INTO employees(id,name,branch_id) VALUES($1,$2,$3)',[employees[index],`Employee ${index}`,id]);
      await database.query("INSERT INTO branch_assignments(id,employee_id,branch_id,effective_from) VALUES($1,$2,$3,'2026-01-01')",[randomUUID(),employees[index],id]);
      await database.query(`INSERT INTO work_schedules(id,branch_id,name,effective_from,is_default,settings) VALUES($1,$2,'Schedule','2026-01-01',TRUE,$3::jsonb)`,
        [randomUUID(),id,JSON.stringify({workDays:[1,2,3,4,5,6,7],entryTime:'08:30',exitTime:'17:30',mealEnabled:false,mealStart:'13:00',mealEnd:'14:00',mealDurationMinutes:60,recognitionMarginMinutes:30})]);
    }
    const hash = (await services.auth.repository.credentials('admin'))!.passwordHash;
    for (const [username,role,employeeId] of [['boss','employee',employees[1]],['human-resources','hr',null]] as const) {
      const id = randomUUID();
      await database.query('INSERT INTO auth_accounts(id,username,name,password_hash,role,employee_id,must_change_password) VALUES($1,$2,$2,$3,$4,$5,FALSE)',[id,username,hash,role,employeeId]);
      if (role === 'hr') await database.query('INSERT INTO auth_account_branches VALUES($1,$2)',[id,branches[0]]);
    }
    root = await login('admin'); hr = await login('human-resources'); boss = await login('boss');
    await call(hr,'PUT',`/employees/${employees[0]}/leave-profile`,{ managerId: employees[1],whatsappPhone: null,vacationBalance: 5,expectedVersion: 0,adjustmentReason: 'Initial balance' });
    for (const [index,id] of employees.entries()) await call(root,'PATCH',`/employees/${id}`,{ contact: { email: `employee${index}@example.test`,whatsappPhone: null,alternatePhone: null,bloodType: null,expectedVersion: 0 } },204);
  },60000);
  afterAll(async () => { await services?.app.close(); await database?.close(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); } });

  it('allows scoped HR to assign a cross-branch boss without exposing their personnel record',async () => {
    const managers = await call(hr,'GET','/manager-options');
    expect(managers.some((item:any) => item.id===employees[1])).toBe(true);
    expect(Object.keys(managers[0]).sort()).toEqual(['branchName','id','name']);
    await call(hr,'GET',`/employees/${employees[1]}`,undefined,403);
    await call(hr,'POST',`/employees/${employees[2]}/access`,{ username: 'other-access' },403);
  });
  it('creates one linked account, sends its encrypted welcome and forces a password change',async () => {
    const issued = await call(hr,'POST',`/employees/${employees[0]}/access`,{ username: 'free.username' });
    expect(issued).not.toHaveProperty('password');
    const queued = (await database.query('SELECT * FROM email_outbox WHERE id=$1',[issued.emailId])).rows[0];
    const content = new EmailContentCipher(key).decrypt(queued.encrypted_content,queued.id);
    const temporary = content.text.match(/Contraseña temporal: (\S+)/)![1];
    expect(queued.encrypted_content).not.toContain(temporary);
    expect(content.text).toContain('http://example.test:8080/reloj/');
    expect((await services.auth.repository.credentials('free.username'))!.passwordHash).not.toContain(temporary);
    let sends = 0;
    const worker = new EmailWorker(database,{ send: async (recipient,message) => { expect(recipient).toBe('employee0@example.test'); expect(message.text).toContain(temporary); sends++; } },key);
    await worker.tick(); await worker.tick();
    expect(sends).toBe(1);
    expect((await database.query('SELECT state,encrypted_content FROM email_outbox WHERE id=$1',[issued.emailId])).rows[0]).toEqual({ state:'accepted',encrypted_content:null });
    const initial = await login('free.username',temporary);
    await call(initial,'GET','/me/profile',undefined,403);
    await call(initial,'POST','/auth/change-password',{ currentPassword: temporary,newPassword: password },204);
    await call(initial,'GET','/auth/me',undefined,401);
    employee = await login('free.username');
  },30000);
  it('rejects duplicate usernames and multiple accounts linked to the same employee',async () => {
    const input = {username:'boss',name:'Duplicate',role:'employee',employeeId:employees[2],branchIds:[],isActive:true,password};
    await call(root,'POST','/auth/accounts',input,409);
    await call(root,'POST','/auth/accounts',{...input,username:'second-account',employeeId:employees[0]},409);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM auth_accounts WHERE employee_id=$1',[employees[0]])).rows[0].count).toBe(1);
  });
  it('restricts employee reads and card exports to the authenticated employee across their history',async () => {
    for (const url of ['/employees','/branches','/devices','/manager-options','/attendance/daily?from=2026-11-12&to=2026-11-12',
      `/employees/${employees[1]}/contact`,`/attendance/cards/export?branchId=${branches[0]}&employeeStatus=active&from=2026-11-12&to=2026-11-12`]) await call(employee,'GET',url,undefined,403);
    const card = await call(employee,'GET',`/me/attendance/card?from=2026-11-12&to=2026-11-12&employeeId=${employees[2]}`);
    expect(card.employee.id).toBe(employees[0]);
    const today = await call(employee,'GET','/me/attendance/today');
    expect(today.employee.id).toBe(employees[0]); expect(today.days).toHaveLength(1);
    await database.query("INSERT INTO branch_assignments(id,employee_id,branch_id,effective_from) VALUES($1,$2,$3,'2025-01-01')",[randomUUID(),employees[0],branches[2]]);
    expect((await call(employee,'GET','/me/attendance/card?from=2025-12-01&to=2025-12-02')).days).toHaveLength(2);
  });
  it('updates only allowed contact fields, preserves leave settings and rejects stale edits atomically',async () => {
    const profile = await call(employee,'GET','/me/profile');
    const input = { whatsappPhone: '+525555555551',alternatePhone: '+525555555552',bloodType: 'O+',expectedVersion: profile.contact.version };
    const saved = await call(employee,'PUT','/me/contact',input);
    expect(saved).toMatchObject({ whatsappPhone: input.whatsappPhone,alternatePhone: input.alternatePhone,bloodType:'O+',email:'employee0@example.test' });
    await call(employee,'PUT','/me/contact',input,409);
    await call(employee,'PUT','/me/contact',{ ...input,expectedVersion:saved.version,email:'attacker@example.test' },400);
    await call(employee,'PUT','/me/contact',{ ...input,expectedVersion:saved.version,managerId:employees[2] },400);
    const stored = (await database.query('SELECT manager_id,vacation_balance,whatsapp_phone FROM employee_leave_profiles WHERE employee_id=$1',[employees[0]])).rows[0];
    expect(stored).toEqual({ manager_id:employees[1],vacation_balance:5,whatsapp_phone:input.whatsappPhone });
    await call(hr,'PATCH',`/employees/${employees[0]}`,{ contact: { ...input,email:'employee0@example.test',expectedVersion:saved.version,bloodType:'AB-' } },204);
    expect((await call(employee,'GET','/me/profile')).contact.bloodType).toBe('AB-');
  });
  it('derives the requester from the session and exposes only own or specifically assigned requests',async () => {
    const created = await createLeave('2026-11-12',true); leaveId = created.id;
    expect(created.employeeId).toBe(employees[0]);
    const own = await call(employee,'GET','/leave-requests?from=2026-01-01&to=2027-01-01&scope=own');
    expect(own.total).toBe(1);
    const assigned = await call(boss,'GET','/leave-requests?from=2026-01-01&to=2027-01-01&scope=assigned');
    expect(assigned.total).toBe(1); expect(assigned.requests[0].id).toBe(leaveId);
    expect((await call(boss,'GET',`/leave-requests/${leaveId}`)).capabilities.canApprove).toBe(true);
    expect((await call(employee,'GET',`/leave-requests/${leaveId}`)).capabilities.canApprove).toBe(false);
    await call(boss,'GET',`/employees/${employees[0]}`,undefined,403);
    await call(employee,'POST',`/leave-requests/${leaveId}/resolve`,{ action:'approve',expectedVersion:1 },403);
    await call(boss,'POST',`/leave-requests/${leaveId}/resolve`,{ action:'approve',expectedVersion:1,actorEmployeeId:employees[1] },400);
  });
  it('denies HR and admin decisions even when their linked employee is the assigned boss',async () => {
    const stored = (await services.auth.repository.credentials('boss'))!;
    const previousPrincipal = { ...stored,sessionHash: 'test-session',csrfToken: 'test-csrf' };
    const leave = new ManageLeave(new PrismaLeaveRepository(database,async () => {}),value => value);
    for (const role of ['hr','admin']) {
      await database.query('UPDATE auth_accounts SET role=$2 WHERE id=$1',[boss.id,role]);
      await expect(leave.resolve(leaveId,{action:'approve',expectedVersion:1,comments:''},previousPrincipal)).rejects.toMatchObject({code:'FORBIDDEN'});
      const detail = await call(boss,'GET',`/leave-requests/${leaveId}`);
      expect(detail.capabilities.canApprove).toBe(false); expect(detail.capabilities.canReject).toBe(false);
      for (const action of ['approve','reject']) await call(boss,'POST',`/leave-requests/${leaveId}/resolve`,{ action,expectedVersion:1,comments:'Forbidden' },403);
    }
    await database.query("UPDATE auth_accounts SET role='employee' WHERE id=$1",[boss.id]);
    expect((await database.query('SELECT status FROM leave_requests WHERE id=$1',[leaveId])).rows[0].status).toBe('pending');
  });
  it('allows the cross-branch boss to approve once and records real identities with vacation accounting',async () => {
    const payload = { action:'approve',expectedVersion:1,comments:'Autorizado' };
    const options = { method:'POST' as const,url:`/leave-requests/${leaveId}/resolve`,payload,headers:{ origin,cookie:boss.cookie,'x-csrf-token':boss.csrf } };
    const results = await Promise.all([services.app.inject(options),services.app.inject(options)]);
    expect(results.map(result=>result.statusCode).sort()).toEqual([200,409]);
    const events = (await database.query("SELECT actor_account_id,actor_employee_id FROM leave_request_events WHERE request_id=$1 AND kind='approved'",[leaveId])).rows;
    expect(events).toEqual([{ actor_account_id:boss.id,actor_employee_id:employees[1] }]);
    expect((await database.query('SELECT vacation_balance FROM employee_leave_profiles WHERE employee_id=$1',[employees[0]])).rows[0].vacation_balance).toBe(4);
    expect((await database.query("SELECT COUNT(*)::int AS count FROM email_outbox WHERE kind='leave'",[])).rows[0].count).toBe(2);
  });
  it('does not retry uncertain mail and expires obsolete welcome credentials before sending',async () => {
    const uncertain = new EmailWorker(database,{ send:async () => { throw new EmailSendError('uncertain','TEST_TIMEOUT'); } },key);
    await uncertain.tick();
    expect((await database.query("SELECT COUNT(*)::int AS count FROM email_outbox WHERE state='uncertain'")).rows[0].count).toBe(1);
    const first = await call(hr,'POST',`/employees/${employees[0]}/access`,{ username:'free.username' });
    const second = await call(hr,'POST',`/employees/${employees[0]}/access`,{ username:'free.username' });
    const sent: string[] = [];
    const worker = new EmailWorker(database,{ send:async (_recipient,content) => { sent.push(content.subject); } },key);
    await worker.tick(); await worker.tick(); await worker.tick();
    expect((await database.query('SELECT state,encrypted_content FROM email_outbox WHERE id=$1',[first.emailId])).rows[0]).toEqual({ state:'expired',encrypted_content:null });
    expect((await database.query('SELECT state FROM email_outbox WHERE id=$1',[second.emailId])).rows[0].state).toBe('accepted');
    expect(sent.filter(subject=>subject==='Tu acceso a Reloj Checador')).toHaveLength(1);
    await call(employee,'GET','/auth/me',undefined,401);
  },30000);
  it('expires temporary passwords and already-open temporary sessions',async () => {
    await database.query("UPDATE auth_accounts SET must_change_password=TRUE,temporary_password_expires_at=NOW()-INTERVAL '1 hour' WHERE id=$1",[boss.id]);
    const response = await services.app.inject({method:'POST',url:'/auth/login',remoteAddress:'127.0.1.250',headers:{origin},payload:{username:'boss',password}});
    expect(response.statusCode).toBe(401);
    await call(boss,'GET','/auth/me',undefined,401);
    await database.query('UPDATE auth_accounts SET must_change_password=FALSE,temporary_password_expires_at=NULL WHERE id=$1',[boss.id]);
    boss = await login('boss');
  });
  it('invalidates existing sessions immediately when an employee is deactivated',async () => {
    await database.query('UPDATE employees SET is_active=FALSE WHERE id=$1',[employees[1]]);
    await call(boss,'GET','/me/profile',undefined,401);
  });
});
