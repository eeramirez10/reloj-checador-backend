import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { PrismaAttendanceDatasource as AttendanceRepository } from '../src/infrastructure/datasources/attendance-datasource.js';

const connectionString = process.env.INTEGRATION_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;

integration('PostgreSQL integration', () => {
  it('keeps a single copy of a repeated event', async () => {
    const database = new Database(connectionString!);
    await runMigrations(database);
    const deviceId = randomUUID();
    try {
      await database.query(`INSERT INTO devices (id, name, ip_address) VALUES ($1, 'Prueba integración', '127.0.0.1')`, [deviceId]);
      const repository = new AttendanceRepository(database);
      const event = { deviceLogId: `integration-${randomUUID()}`, userId: '15', occurredAt: new Date('2026-07-31T08:00:00Z'),
        raw: { uid: 15, deviceLocalTime: '2026-07-31 02:00:00', deviceTimeZone: 'America/Mexico_City' } };
      expect(await repository.insertIfNew(deviceId, event)).toBe(true);
      expect(await repository.insertIfNew(deviceId, event)).toBe(false);
      const corrected = { ...event, occurredAt: new Date('2026-07-31T07:00:00Z'), raw: { ...event.raw, deviceTimeZone: 'America/Cancun' } };
      expect(await repository.insertIfNew(deviceId, corrected)).toBe(false);
      const records = (await database.query<{ occurred_at: Date }>('SELECT occurred_at FROM attendance_logs WHERE device_id = $1', [deviceId])).rows;
      expect(records).toHaveLength(1);
      expect(records[0].occurred_at).toEqual(event.occurredAt);
    } finally {
      await database.query('DELETE FROM attendance_logs WHERE device_id = $1', [deviceId]);
      await database.query('DELETE FROM devices WHERE id = $1', [deviceId]);
      await database.close();
    }
  });
});
