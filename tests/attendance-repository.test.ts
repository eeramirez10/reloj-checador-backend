import { describe, expect, it, vi } from 'vitest';
import { PrismaAttendanceDatasource as AttendanceRepository } from '../src/infrastructure/datasources/attendance-datasource.js';

describe('AttendanceRepository', () => {
  it('does not duplicate the same attendance event', async () => {
    const eventKeys = new Set<string>();
    const repository = new AttendanceRepository({
      query: async (_sql: string, values: unknown[] = []) => {
        const key = values[2] as string;
        if (eventKeys.has(key)) return { rows: [], rowCount: 0 };
        eventKeys.add(key);
        return { rows: [{ id: values[0] as string }], rowCount: 1 };
      }
    } as any);
    const deviceId = 'd2719e4e-36d4-4b70-b585-0b1576c4d7b5';
    const event = { deviceLogId: '42', userId: '15', occurredAt: new Date('2026-07-31T08:00:00Z'), raw: { uid: 15 } };
    expect(await repository.insertIfNew(deviceId, event)).toBe(true);
    expect(await repository.insertIfNew(deviceId, event)).toBe(false);
  });

  it('backfills verification and punch state on an existing event', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const repository = new AttendanceRepository({
      query: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        return text.startsWith('INSERT') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 };
      }
    } as any);
    const event = {
      deviceLogId: '15645', userId: '1514', verificationType: 1, punchState: 0,
      occurredAt: new Date('2026-07-31T08:00:00Z'), raw: { userSn: 15_645, verificationType: 1, punchState: 0 }
    };

    expect(await repository.insertIfNew('device-1', event)).toBe(false);
    expect(queries[1].text).toContain('verification_type = COALESCE');
    expect(queries[1].values).toContain(0);
    expect(queries[1].values.at(-1)).toBe(JSON.stringify(event.raw));
  });

  it('returns the associated profile-photo availability', async () => {
    const query = vi.fn(async (_sql: string) => ({
      rows: [{
        id: 'log-1',
        device_id: 'device-1',
        device_log_id: '15645',
        user_id: '1514',
        verification_type: 1,
        punch_state: 0,
        occurred_at: new Date('2026-07-31T08:00:00Z'),
        raw_data: {},
        received_at: new Date('2026-07-31T08:01:00Z'),
        user_name: 'Ana',
        user_has_photo: true,
      }],
      rowCount: 1,
    }));
    const repository = new AttendanceRepository({ query } as any);

    const [log] = await repository.list({ limit: 100 });

    expect(query.mock.calls[0][0]).toContain('device_user_photos');
    expect(log.userHasPhoto).toBe(true);
  });
});
