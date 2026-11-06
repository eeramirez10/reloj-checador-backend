import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database, type Queryable } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { PrismaAttendanceDatasource } from '../src/infrastructure/datasources/attendance-datasource.js';
import type { ZktecoAttendanceEvent } from '../src/domain/datasources/device-client.js';

const integration = process.env.INTEGRATION_DATABASE_URL ? describe : describe.skip;
integration('batched native attendance with original identity preservation', () => {
  const schema = `test_batch_${randomUUID().replaceAll('-','')}`;
  const devices = [randomUUID(),randomUUID()];
  const branchId = randomUUID();
  let admin: Database; let database: Database;
  const event = (userId: string, serial: string | undefined, time: string, raw: object = {}): ZktecoAttendanceEvent => ({
    userId,deviceLogId:serial,occurredAt:new Date(`2026-10-21T${time}Z`),verificationType:1,punchState:0,raw,
  });
  async function logs(deviceId: string) {
    return (await database.query<{ record: Record<string,unknown> }>(`SELECT to_jsonb(a) AS record FROM attendance_logs a WHERE device_id=$1 ORDER BY event_key`,[deviceId])).rows.map(row=>row.record);
  }
  beforeAll(async () => {
    admin = new Database(process.env.INTEGRATION_DATABASE_URL!); await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.INTEGRATION_DATABASE_URL!); url.searchParams.set('options',`-c search_path=${schema}`);
    database = new Database(url.toString()); await runMigrations(database);
    await database.query("INSERT INTO branches(id,name) VALUES($1,'Batch comparison')",[branchId]);
    for (const [index,device] of devices.entries()) await database.query("INSERT INTO devices(id,name,ip_address,driver,branch_id) VALUES($1,'Batch clock',$2,'node',$3)",[device,`127.0.0.${90+index}`,branchId]);
  });
  afterAll(async () => { await database?.close(); if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();} });

  it('matches sequential storage for native, legacy, reused, same-minute imported and ambiguous records',async () => {
    const ids = new Map<string,string>();
    for (const device of devices) {
      for (const [userId,time,key,raw] of [
        ['11','14:30:00','file-one',{source:'talavie_file',original:'one'}],
        ['12','14:31:00','file-two-a',{source:'talavie_file',original:'ambiguous-a'}],
        ['12','14:31:20','file-two-b',{source:'talavie_file',original:'ambiguous-b'}],
        ['19','14:50:01','legacy-folio',{deviceLocalTime:'2026-10-21 08:50:01',original:true}],
      ] as const) {
        const id = randomUUID(); ids.set(`${device}:${key}`,id);
        await database.query(`INSERT INTO attendance_logs(id,device_id,event_key,device_log_id,user_id,occurred_at,raw_data,branch_id)
          VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,[id,device,key,key==='legacy-folio'?key:null,userId,`2026-10-21T${time}Z`,JSON.stringify(raw),branchId]);
      }
      const noId = {userId:'18',occurredAt:new Date('2026-10-21T14:55:00Z'),raw:{}};
      const key = createHash('sha256').update(JSON.stringify([noId.userId,noId.occurredAt.toISOString(),undefined,undefined])).digest('hex');
      await database.query("INSERT INTO attendance_logs(id,device_id,event_key,user_id,occurred_at,raw_data,branch_id) VALUES($1,$2,$3,'18',$4,'{}',$5)",[randomUUID(),device,key,noId.occurredAt,branchId]);
    }
    const original = await logs(devices[1]);
    const input: ZktecoAttendanceEvent[] = [
      event('11','import-native','14:30:37',{native:true}), event('11','second-native','14:30:50',{native:true}),event('11','file-one','14:30:00'),
      event('12','ambiguous-native','14:31:40'), event('15','1','14:40:00'),
      {...event('15','1','14:40:00'),occurredAt:new Date('2026-10-22T14:40:00Z')},event('16','1','14:40:00'),
      {...event('15','1','14:40:00'),verificationType:15,punchState:1,raw:{changed:true}},
      event('19','legacy-folio','14:50:01',{deviceLocalTime:'2026-10-21 08:50:01'}),
      event('19','legacy-folio','13:50:01',{deviceLocalTime:'2026-10-21 08:50:01'}),
      {userId:'18',occurredAt:new Date('2026-10-21T14:55:00Z'),raw:{}},
      event('20',undefined,'14:59:00',{userSn:1000}),event('20','1000','14:59:00'),
    ];
    const source = new PrismaAttendanceDatasource(database);
    let sequential = 0;
    for(const row of input) if(await source.insertIfNew(devices[0],row)) sequential++;
    expect(await source.insertBatchIfNew(devices[1],input)).toBe(sequential);
    const normalize = (rows: Record<string,unknown>[]) => rows.map(({id:_id,device_id:_device,received_at:_received,...rest})=>rest);
    expect(normalize(await logs(devices[1]))).toEqual(normalize(await logs(devices[0])));
    const after = await logs(devices[1]);
    for(const row of original.filter(row=>row.event_key!=='file-one')) expect(after.find(item=>item.id===row.id)).toEqual(row);
    const enriched = after.find(row=>row.id===ids.get(`${devices[1]}:file-one`))!;
    expect(enriched.raw_data).toMatchObject({native:true,importEvidence:{source:'talavie_file',original:'one'}});
    expect(await source.insertBatchIfNew(devices[1],input)).toBe(0);
    expect(await logs(devices[1])).toEqual(after);
  });
  it('uses bounded round trips for hundreds of new records and only two for a repeated download',async () => {
    let queries = 0;
    const track = (client: Queryable): Queryable => ({prisma:client.prisma,query:async(text,values)=>{queries++;return client.query(text,values);}});
    const tracked = { ...track(database),transaction:<T>(operation:(client:Queryable)=>Promise<T>)=>database.transaction(client=>operation(track(client))) };
    const source = new PrismaAttendanceDatasource(tracked);
    const input = Array.from({length:750},(_,index)=>event('batch-user',String(index),`${String(Math.floor(index/60)).padStart(2,'0')}:${String(index%60).padStart(2,'0')}:00`));
    expect(await source.insertBatchIfNew(devices[1],input)).toBe(750);
    expect(queries).toBe(4);
    const before = await logs(devices[1]); queries = 0;
    expect(await source.insertBatchIfNew(devices[1],input)).toBe(0);
    expect(queries).toBe(2);
    expect(await logs(devices[1])).toEqual(before);
  });
  it('rolls back a failed batch and releases its lock without losing existing evidence',async () => {
    await database.executeScript(`CREATE FUNCTION fail_batch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='reject' THEN RAISE EXCEPTION 'batch_failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_batch BEFORE INSERT ON attendance_logs FOR EACH ROW EXECUTE FUNCTION fail_batch();`);
    const source = new PrismaAttendanceDatasource(database);
    const before = await logs(devices[1]);
    await expect(source.insertBatchIfNew(devices[1],[event('accepted-before-failure','a','20:00:00'),event('reject','b','20:00:00')])).rejects.toThrow();
    expect(await logs(devices[1])).toEqual(before);
    await database.executeScript('DROP TRIGGER reject_batch ON attendance_logs; DROP FUNCTION fail_batch();');
    expect(await source.insertBatchIfNew(devices[1],[event('accepted-after-failure','a','20:00:00')])).toBe(1);
  });
});
