import { randomUUID } from 'node:crypto';
import type { Database } from '../db/database.js';
import { formatDateTimeInTimeZone } from '../attendance/attendance-summary.js';
import type { ScheduleSettings } from './schemas.js';

export async function initializeOrganization(database: Database): Promise<void> {
  await database.transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('organization-initialization'))");
    if ((await client.query("SELECT id FROM organization_initializations WHERE code = 'mexico-initial-assignment'")).rows.length) return;
    const clock = (await client.query<{ id: string }>("SELECT id FROM devices WHERE id = 'ffa6b402-8ba2-4bb3-807e-21f84b416713' AND deleted_at IS NULL")).rows[0];
    if (!clock) return;
    const today = formatDateTimeInTimeZone(new Date(), 'America/Mexico_City').slice(0, 10);
    const mexico = randomUUID();
    await client.query("INSERT INTO branches (id, name) VALUES ($1, 'México')", [mexico]);
    if (clock) {
      await client.query('UPDATE devices SET branch_id = $1 WHERE id = $2', [mexico, clock.id]);
      await client.query(`UPDATE device_users u SET branch_id = $1, employee_id = e.id FROM employees e
        WHERE u.device_id = $2 AND e.normalized_employee_number = COALESCE(NULLIF(LTRIM(u.device_user_id, '0'), ''), '0')`, [mexico, clock.id]);
      await client.query('UPDATE device_users SET branch_id = $1 WHERE device_id = $2', [mexico, clock.id]);
      await client.query('UPDATE employees SET branch_id = $1 WHERE id IN (SELECT employee_id FROM device_users WHERE device_id = $2)', [mexico, clock.id]);
      await client.query('UPDATE attendance_logs SET branch_id = $1 WHERE device_id = $2 AND branch_id IS NULL', [mexico, clock.id]);
    }
    for (const [table, column] of [['employees', 'employee_id'], ['device_users', 'device_user_id'], ['devices', 'device_id']]) {
      const targets = (await client.query<{ id: string; branch_id: string }>(`SELECT id, branch_id FROM ${table} WHERE branch_id IS NOT NULL`)).rows;
      for (const target of targets) await client.query(`INSERT INTO branch_assignments (id, ${column}, branch_id, effective_from) VALUES ($1,$2,$3,'1900-01-01')`, [randomUUID(), target.id, target.branch_id]);
    }
    await client.query('INSERT INTO branch_policies (id, branch_id, effective_from, settings) VALUES ($1,$2,$3,$4)',
      [randomUUID(), mexico, today, JSON.stringify({ entryToleranceMinutes: 0, mealToleranceMinutes: 0,
        entryAllowedTardies: 3, mealAllowedTardies: 3, accumulationMode: 'first_lateness', accumulationDays: 30 })]);
    const settings: ScheduleSettings = { workDays: [1, 2, 3, 4, 5], entryTime: '08:30', exitTime: '18:00',
      mealEnabled: false, mealStart: '14:00', mealEnd: '15:00', mealDurationMinutes: 60 };
    await client.query(`INSERT INTO work_schedules (id, branch_id, name, effective_from, is_default, settings) VALUES ($1,$2,$3,$4,TRUE,$5)`,
      [randomUUID(), mexico, 'México · jornada base', today, JSON.stringify(settings)]);
    if (clock) {
      const user = (await client.query<{ id: string; employee_id: string | null }>("SELECT id, employee_id FROM device_users WHERE device_id = $1 AND device_user_id = '1517'", [clock.id])).rows[0];
      if (user) {
        const scheduleId = randomUUID();
        await client.query('INSERT INTO work_schedules (id, branch_id, name, effective_from, settings) VALUES ($1,$2,$3,$4,$5)',
          [scheduleId, mexico, 'Comida 14:00–15:00 · 60 minutos', today, JSON.stringify({ ...settings, mealEnabled: true })]);
        await client.query('INSERT INTO schedule_assignments (id, employee_id, device_user_id, schedule_id, effective_from) VALUES ($1,$2,$3,$4,$5)',
          [randomUUID(), user.employee_id, user.employee_id ? null : user.id, scheduleId, today]);
      }
    }
    await client.query("INSERT INTO organization_initializations (id, code) VALUES ($1,'mexico-initial-assignment')", [randomUUID()]);
  });
}
