import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/main.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;

integration('manual employee access without email configuration', () => {
  const schema = `test_manual_access_${randomUUID().replaceAll('-', '')}`;
  const origin = 'http://127.0.0.1:5173';
  const password = 'Manual test password 2026!';
  const temporary = 'Temporary manual access 2026!';
  const branches = [randomUUID(), randomUUID()];
  const employees = Array.from({ length: 5 }, () => randomUUID());
  type Session = { cookie: string; csrf: string };
  let admin: Database;
  let database: Database;
  let services: Awaited<ReturnType<typeof buildApp>>;
  let root: Session;
  let hr: Session;
  let manager: Session;
  let staff: Session;
  let address = 1;

  async function login(username: string, value = password, expected = 204) {
    const response = await services.app.inject({ method: 'POST', url: '/auth/login', remoteAddress: `127.8.0.${address++}`,
      headers: { origin }, payload: { username, password: value } });
    expect(response.statusCode, response.body).toBe(expected);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    if (expected !== 204) return { cookie: '', csrf: '' };
    const me = await services.app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
    expect(me.statusCode, me.body).toBe(200);
    return { cookie, csrf: me.json().csrfToken };
  }

  async function call(session: Session, method: 'GET' | 'POST', url: string, payload?: object, expected = 200) {
    const response = await services.app.inject({ method, url, headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrf }, payload });
    expect(response.statusCode, response.body).toBe(expected);
    return response.body ? response.json() : null;
  }

  beforeAll(async () => {
    admin = new Database(connection!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    database = new Database(url.toString());
    await runMigrations(database);
    services = await buildApp({ database, email: { settings: { enabled: false, encryptionKey: '', publicUrl: origin } } });
    const rootAccount = await services.auth.save(null, { username: 'admin', name: 'Administrator', role: 'admin', branchIds: [], isActive: true }, password);
    for (const id of branches) await database.query('INSERT INTO branches(id,name) VALUES($1,$2)', [id, id]);
    for (const [index, id] of employees.entries()) {
      await database.query('INSERT INTO employees(id,name,branch_id) VALUES($1,$2,$3)', [id, `Manual employee ${index}`, branches[index === 2 ? 1 : 0]]);
    }
    await database.query('UPDATE employees SET is_active=FALSE WHERE id=$1', [employees[3]]);
    await database.query("UPDATE employees SET identification_status='pending' WHERE id=$1", [employees[4]]);
    await services.auth.save(rootAccount.id, { username: 'human-resources', name: 'Human resources', role: 'hr', branchIds: [branches[0]], isActive: true }, password);
    await services.auth.save(rootAccount.id, { username: 'manager', name: 'Manager', role: 'manager', branchIds: [branches[0]], isActive: true }, password);
    await database.query('UPDATE auth_accounts SET must_change_password=FALSE,temporary_password_expires_at=NULL');
    root = await login('admin');
    hr = await login('human-resources');
    manager = await login('manager');
  }, 60000);

  afterAll(async () => {
    await services?.app.close();
    await database?.close();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); }
  });

  it('creates an employee account through account administration without any email address or key', async () => {
    const account = await call(root, 'POST', '/auth/accounts', { username: 'manual.admin', name: 'Custom account name', role: 'employee',
      employeeId: employees[0], branchIds: [], isActive: true, password: temporary }, 201);
    expect(account).toMatchObject({ employeeId: employees[0], name: 'Custom account name', mustChangePassword: true });
    expect(JSON.stringify(account)).not.toContain(temporary);
    expect(Date.parse(account.temporaryPasswordExpiresAt) - Date.now()).toBeGreaterThan(23 * 3600000);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM email_outbox')).rows[0].count).toBe(0);
    await login('manual.admin', temporary);
  });

  it('allows scoped HR to issue manual credentials from the employee file without creating mail', async () => {
    const issued = await call(hr, 'POST', `/employees/${employees[1]}/access`, { username: 'manual.hr', delivery: 'manual', password: temporary });
    expect(issued).toEqual({ username: 'manual.hr', emailId: null });
    const view = await call(hr, 'GET', `/employees/${employees[1]}/access`);
    expect(view.account).toMatchObject({ username: 'manual.hr', role: 'employee', isActive: true, mustChangePassword: true });
    expect(view.messages).toEqual([]);
    const credentials = await services.auth.repository.credentials('manual.hr');
    expect(credentials!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(credentials!.passwordHash).not.toContain(temporary);
    const audit = (await database.query("SELECT metadata FROM auth_audit_events WHERE action='employee_access_issued'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ employeeId: employees[1], delivery: 'manual', emailId: null });
    expect(JSON.stringify(audit)).not.toContain(temporary);
  });

  it('forces a password change before allowing personal access and derives the correct employee', async () => {
    const initial = await login('manual.hr', temporary);
    await call(initial, 'GET', '/me/profile', undefined, 403);
    await call(initial, 'POST', '/auth/change-password', { currentPassword: temporary, newPassword: password }, 204);
    await call(initial, 'GET', '/auth/me', undefined, 401);
    staff = await login('manual.hr');
    expect((await call(staff, 'GET', '/me/profile')).employeeId).toBe(employees[1]);
    await call(staff, 'GET', '/employees', undefined, 403);
  });

  it('resets the linked account without duplication and revokes its existing password and sessions', async () => {
    await call(hr, 'POST', `/employees/${employees[1]}/access`, { username: 'manual.hr', delivery: 'manual', password: temporary });
    await call(staff, 'GET', '/auth/me', undefined, 401);
    await login('manual.hr', password, 401);
    await login('manual.hr', temporary);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM auth_accounts WHERE employee_id=$1', [employees[1]])).rows[0].count).toBe(1);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM email_outbox')).rows[0].count).toBe(0);
  });

  it('preserves branch, role, employee status, unique username and linked privilege restrictions', async () => {
    const input = { username: 'blocked', delivery: 'manual', password: temporary };
    await call(hr, 'POST', `/employees/${employees[2]}/access`, input, 403);
    await call(manager, 'POST', `/employees/${employees[1]}/access`, input, 403);
    for (const id of [employees[3], employees[4]]) await call(root, 'POST', `/employees/${id}/access`, input, 403);
    await call(hr, 'POST', `/employees/${employees[1]}/access`, { ...input, username: 'admin' }, 409);
    await call(root, 'POST', '/auth/accounts', { username: 'duplicate.link', name: 'Duplicate', role: 'employee', employeeId: employees[0], branchIds: [], isActive: true, password: temporary }, 409);
    const current = (await services.auth.repository.credentials('manual.hr'))!;
    await database.query("UPDATE auth_accounts SET role='manager' WHERE id=$1", [current.id]);
    await call(hr, 'POST', `/employees/${employees[1]}/access`, input, 400);
    await database.query("UPDATE auth_accounts SET role='employee' WHERE id=$1", [current.id]);
  });

  it('rejects incomplete manual credentials and keeps email configuration errors specific to email delivery', async () => {
    const url = `/employees/${employees[1]}/access`;
    for (const input of [{ username: 'manual.hr', delivery: 'manual' }, { username: 'manual.hr', delivery: 'manual', password: 'short' },
      { username: 'manual.hr', delivery: 'email', password: temporary }]) await call(hr, 'POST', url, input, 400);
    await call(hr, 'POST', url, { username: 'manual.hr', delivery: 'email' }, 400);
    expect((await database.query('SELECT COUNT(*)::int AS count FROM email_outbox')).rows[0].count).toBe(0);
    await login('manual.hr', temporary);
  });
});
