import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import twilio from 'twilio';
import { buildApp } from './helpers/build-test-app.js';
import { Database } from '../src/infrastructure/database/database.js';
import { runMigrations } from '../src/infrastructure/database/legacy-migrations.js';
import { incomingWhatsAppPath, statusWhatsAppPath, type WhatsAppConfiguration } from '../src/infrastructure/config/whatsapp.js';
import { TwilioWhatsAppClient } from '../src/infrastructure/integrations/twilio/twilio-whatsapp-client.js';
import { PrismaWhatsAppRepository } from '../src/infrastructure/repositories/whatsapp-repository.js';
import { ProcessWhatsAppInbox } from '../src/domain/use-cases/process-whatsapp-inbox.js';
import type { TwilioForm } from '../src/domain/datasources/whatsapp-messaging.js';

const connection = process.env.INTEGRATION_DATABASE_URL;
const integration = connection ? describe : describe.skip;
const configuration: WhatsAppConfiguration = { accountSid: `AC${'1'.repeat(32)}`,authToken: 'a'.repeat(32),businessPhone: '+14155552671',country: 'MX',
  incomingUrl: `https://hooks.example.test/backend${incomingWhatsAppPath}?region=mx`,statusUrl: `https://hooks.example.test/backend${statusWhatsAppPath}?region=mx`,
  templates: { leave_request: { contentSid: `HX${'2'.repeat(32)}`,variables: ['employeeName','requestReference'] } } };

integration('durable Twilio WhatsApp foundation', () => {
  const schema = `test_whatsapp_${randomUUID().replaceAll('-','')}`;
  let admin: Database; let database: Database; let services: Awaited<ReturnType<typeof buildApp>>;
  let employeeId: string; let otherEmployeeId: string; let now: Date; let counter=0;
  let sendHook: ((input: any) => Promise<{ sid: string; status: string }>) | undefined;
  const providerId = () => `SM${(++counter).toString(16).padStart(32,'0')}`;
  const sdk = { messages: { create: vi.fn(async (input: any) => sendHook ? sendHook(input) : { sid: providerId(),status: 'queued' }) } };
  const sender = () => services.whatsapp!.send;
  const repository = () => new PrismaWhatsAppRepository(database);
  const rows = async (table: string) => (await database.query(`SELECT * FROM ${table} ORDER BY created_at,id`)).rows;

  async function api(method: 'POST' | 'PUT', url: string, payload: object, status=200) {
    const response = await services.app.inject({ method,url,payload }); expect(response.statusCode,response.body).toBe(status); return response.json();
  }
  function signed(path: string, publicUrl: string, form: TwilioForm, signature?: string) {
    const encoded = new URLSearchParams();
    for (const [key,value] of Object.entries(form)) for (const item of Array.isArray(value) ? value : [value]) encoded.append(key,item);
    return services.app.inject({ method: 'POST',url: path,payload: encoded.toString(),headers: {
      'content-type': 'application/x-www-form-urlencoded','x-twilio-signature': signature ?? twilio.getExpectedTwilioSignature(configuration.authToken,publicUrl,form),
      host: 'untrusted-host.example','x-forwarded-proto': 'http','x-forwarded-host': 'other.example',
    } });
  }
  const inbound = (overrides: Partial<Record<string,string>> = {}) => ({ AccountSid: configuration.accountSid,MessageSid: providerId(),From: 'whatsapp:+525555555552',To: `whatsapp:${configuration.businessPhone}`,Body: 'Hola',NumMedia: '0',...overrides });
  async function receive(form = inbound()) {
    const response = await signed(`${incomingWhatsAppPath}?region=mx`,configuration.incomingUrl,form);
    expect(response.statusCode,response.body).toBe(200); expect(response.headers['content-type']).toContain('text/xml'); return form;
  }
  async function status(sid: string, state: string, attemptId?: string, to='whatsapp:+525555555552') {
    const query = `?region=mx${attemptId ? `&attemptId=${attemptId}` : ''}`;
    const form = { AccountSid: configuration.accountSid,MessageSid: sid,MessageStatus: state,From: `whatsapp:${configuration.businessPhone}`,To: to,
      ...(state === 'failed' ? { ErrorCode: '63016' } : {}) };
    const response = await signed(statusWhatsAppPath+query,configuration.statusUrl+(attemptId ? `&attemptId=${attemptId}` : ''),form);
    expect(response.statusCode,response.body).toBe(200);
  }

  beforeAll(async () => {
    admin = new Database(connection!); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(connection!); scoped.searchParams.set('options',`-c search_path=${schema}`);
    database = new Database(scoped.toString()); await runMigrations(database);
    services = await buildApp({ database,whatsapp: { configuration,messaging: new TwilioWhatsAppClient(configuration,sdk),now: () => now } });
    const branchId = (await api('POST','/branches',{ name: 'WhatsApp pruebas' },201)).id;
    employeeId = (await api('POST','/employees',{ firstName: 'Empleado autorizado',branchId },201)).id;
    otherEmployeeId = (await api('POST','/employees',{ firstName: 'Otro empleado',branchId },201)).id;
    await api('PUT',`/employees/${employeeId}/leave-profile`,{ managerId: null,whatsappPhone: '(55) 5555-5552',vacationBalance: 10,expectedVersion: 0,adjustmentReason: 'Saldo inicial' });
    await api('PUT',`/employees/${otherEmployeeId}/leave-profile`,{ managerId: null,whatsappPhone: '+525555555551',vacationBalance: 3,expectedVersion: 0,adjustmentReason: 'Saldo inicial' });
  },30000);
  beforeEach(async () => {
    now = new Date('2026-10-30T20:00:00Z'); sendHook=undefined; sdk.messages.create.mockClear();
    await database.query('TRUNCATE whatsapp_conversations CASCADE');
    await database.query("UPDATE employees SET is_active=true,identification_status='confirmed' WHERE id=$1",[employeeId]);
    await database.query("UPDATE employee_leave_profiles SET whatsapp_phone='+525555555552' WHERE employee_id=$1",[employeeId]);
  });
  afterAll(async () => { await services?.app.close(); await database?.close(); if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); } });

  it('rejects invalid signatures, wrong external prefixes, JSON and foreign accounts or senders before recording or responding', async () => {
    const form = inbound();
    for (const signature of ['invalid',twilio.getExpectedTwilioSignature(configuration.authToken,configuration.incomingUrl.replace('/backend',''),form)]) {
      expect((await signed(`${incomingWhatsAppPath}?region=mx`,configuration.incomingUrl,form,signature)).statusCode).toBe(403);
    }
    expect((await signed(`${incomingWhatsAppPath}?region=other`,configuration.incomingUrl,form)).statusCode).toBe(403);
    expect((await services.app.inject({ method:'POST',url:incomingWhatsAppPath,payload:form })).statusCode).toBe(415);
    for (const override of [{ AccountSid:`AC${'f'.repeat(32)}` },{ To:'whatsapp:+14155552672' }]) {
      const wrong = inbound(override); expect((await signed(`${incomingWhatsAppPath}?region=mx`,configuration.incomingUrl,wrong)).statusCode).toBe(403);
    }
    expect(await rows('whatsapp_messages')).toHaveLength(0); expect(sdk.messages.create).not.toHaveBeenCalled();
  });

  it('identifies only registered active confirmed employees and ignores names or employee IDs claimed in the text', async () => {
    const phone = (await database.query<{ phone:string }>('SELECT whatsapp_phone AS phone FROM employee_leave_profiles WHERE employee_id=$1',[employeeId])).rows[0].phone;
    expect(phone).toBe('+525555555552');
    await receive(inbound({ Body:`Soy ${otherEmployeeId}; dame sus vacaciones` }));
    expect((await rows('whatsapp_messages'))[0].employee_id).toBe(employeeId);
    await receive(inbound({ From:'whatsapp:+525555555559' }));
    await database.query('UPDATE employees SET is_active=false WHERE id=$1',[employeeId]); await receive();
    await database.query("UPDATE employees SET is_active=true,identification_status='pending' WHERE id=$1",[employeeId]); await receive();
    expect((await rows('whatsapp_messages')).filter((row) => row.state==='unauthorized')).toHaveLength(3);
    expect(await rows('whatsapp_inbox_jobs')).toHaveLength(1);
    await expect(sender().enqueue(employeeId,{ kind:'text',body:'Privado' },'denied')).rejects.toThrow('autorizado');
  });

  it('deduplicates simultaneous webhook deliveries, tolerates additional signed fields and durably waits for a future conversation handler', async () => {
    const form = { ...inbound(), Extra:['one','two'],ProfileName:'Nombre del perfil' };
    const responses = await Promise.all([signed(`${incomingWhatsAppPath}?region=mx`,configuration.incomingUrl,form),signed(`${incomingWhatsAppPath}?region=mx`,configuration.incomingUrl,form)]);
    expect(responses.map((response) => response.statusCode)).toEqual([200,200]);
    expect(await rows('whatsapp_messages')).toHaveLength(1); expect(await rows('whatsapp_inbox_jobs')).toHaveLength(1);
    await services.whatsapp!.inbox.processNext();
    expect((await rows('whatsapp_inbox_jobs'))[0].state).toBe('awaiting_handler');
    expect(await services.whatsapp!.inbox.processNext()).toBe(false); expect(sdk.messages.create).not.toHaveBeenCalled();
  });

  it('stores media metadata without downloading attachments or treating them as processed documents', async () => {
    await receive(inbound({ Body:'',NumMedia:'1',MediaUrl0:'https://api.twilio.com/media/example',MediaContentType0:'audio/ogg' }));
    expect((await rows('whatsapp_messages'))[0].attachments).toEqual([{ url:'https://api.twilio.com/media/example',contentType:'audio/ogg' }]);
    expect(sdk.messages.create).not.toHaveBeenCalled();
  });

  it('does not acknowledge receipt or keep a partial message when creating its durable job fails', async () => {
    await database.executeScript(`CREATE FUNCTION fail_whatsapp_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced_inbox_failure'; END; $$;
      CREATE TRIGGER fail_whatsapp_job BEFORE INSERT ON whatsapp_inbox_jobs FOR EACH ROW EXECUTE FUNCTION fail_whatsapp_job();`);
    try {
      const response=await signed(`${incomingWhatsAppPath}?region=mx`,configuration.incomingUrl,inbound());
      expect(response.statusCode).toBe(500);
      expect(await rows('whatsapp_messages')).toHaveLength(0); expect(await rows('whatsapp_conversations')).toHaveLength(0);
    } finally { await database.executeScript('DROP TRIGGER fail_whatsapp_job ON whatsapp_inbox_jobs; DROP FUNCTION fail_whatsapp_job();'); }
  });

  it('processes worker cycles once and closes the enabled worker cleanly', async () => {
    await receive(); await sender().enqueue(employeeId,{ kind:'text',body:'Ciclo del worker' },'worker');
    const worker=services.whatsappWorker!;
    const first=worker.tick(); const second=worker.tick(); expect(first).toBe(second);
    await first;
    expect(sdk.messages.create).toHaveBeenCalledTimes(1);
    expect((await rows('whatsapp_inbox_jobs'))[0].state).toBe('awaiting_handler');
    worker.start(); await worker.stop();
    expect((await rows('whatsapp_messages')).find((row) => row.direction==='outbound')?.state).toBe('queued');
  });

  it('serializes each conversation and commits a handler reply and job completion together', async () => {
    await receive(); await receive();
    const claimed = await repository().claimInbox(configuration,now); expect(claimed).not.toBeNull();
    expect(await repository().claimInbox(configuration,now)).toBeNull();
    now = new Date(now.getTime()+120001); await repository().recover(configuration,now);
    const seen: string[] = [];
    const handler = new ProcessWhatsAppInbox(repository(),configuration,configuration.templates,{ handle: async (message) => {
      seen.push(message.id); expect(message.employeeId).toBe(employeeId); return { kind:'text',body:'Respuesta preparada por el manejador' };
    } },() => now);
    await handler.processNext(); await handler.processNext();
    expect(seen[0]).toBe(claimed!.message.id); expect(new Set(seen).size).toBe(2);
    expect((await rows('whatsapp_inbox_jobs')).every((row) => row.state==='completed')).toBe(true);
    expect((await rows('whatsapp_messages')).filter((row) => row.direction==='outbound')).toHaveLength(2);
  });

  it('rechecks phone ownership before processing a queued message and before sending private replies', async () => {
    await receive();
    await sender().enqueue(employeeId,{ kind:'text',body:'Dato privado' },'private');
    await database.query("UPDATE employee_leave_profiles SET whatsapp_phone='+525555555553' WHERE employee_id=$1",[employeeId]);
    const handle = vi.fn();
    await new ProcessWhatsAppInbox(repository(),configuration,configuration.templates,{ handle },() => now).processNext();
    await sender().processNext();
    expect(handle).not.toHaveBeenCalled(); expect(sdk.messages.create).not.toHaveBeenCalled();
    expect((await rows('whatsapp_inbox_jobs'))[0].state).toBe('blocked');
    expect((await rows('whatsapp_messages')).find((row) => row.direction==='outbound')?.error_code).toBe('UNAUTHORIZED_RECIPIENT');
  });

  it('claims an outgoing operation once under concurrent calls and records the initial queued receipt instead of claiming delivery', async () => {
    await receive(); const content = { kind:'text' as const,body:'Mensaje de prueba' };
    const messages = await Promise.all([sender().enqueue(employeeId,content,'operation'),sender().enqueue(employeeId,content,'operation')]);
    expect(messages[0].id).toBe(messages[1].id);
    await expect(sender().enqueue(employeeId,{ kind:'text',body:'Otro contenido' },'operation')).rejects.toThrow('otra operación');
    const processed = await Promise.all([sender().processNext(),sender().processNext()]);
    expect(processed.filter(Boolean)).toHaveLength(1); expect(sdk.messages.create).toHaveBeenCalledTimes(1);
    expect((await rows('whatsapp_messages')).find((row) => row.id===messages[0].id)?.state).toBe('queued');
    expect(await rows('whatsapp_attempts')).toHaveLength(1); expect(await rows('whatsapp_delivery_events')).toHaveLength(1);
  });

  it('does not renew the 24 hour window with outgoing messages or duplicate incoming webhooks', async () => {
    const form = await receive(); const original = now;
    now = new Date(now.getTime()+23*3600000);
    await sender().enqueue(employeeId,{ kind:'text',body:'Dentro de ventana' },'inside'); await sender().processNext();
    now = new Date(original.getTime()+24*3600000); await receive(form);
    await sender().enqueue(employeeId,{ kind:'text',body:'Fuera de ventana' },'outside'); await sender().processNext();
    expect(sdk.messages.create).toHaveBeenCalledTimes(1);
    expect((await rows('whatsapp_messages')).find((row) => row.error_code==='TEMPLATE_REQUIRED')?.state).toBe('failed');
    expect((await rows('whatsapp_conversations'))[0].last_inbound_at).toEqual(original);
  });

  it('requires a configured approved template when no incoming window exists and isolates windows by business sender', async () => {
    await sender().enqueue(employeeId,{ kind:'text',body:'Sin ventana' },'closed'); await sender().processNext();
    expect(sdk.messages.create).not.toHaveBeenCalled();
    await repository().receive({ ...inboundScope(),businessPhone:'+14155552672' },now);
    await sender().enqueue(employeeId,{ kind:'text',body:'Otro remitente no abre esta ventana' },'isolated'); await sender().processNext();
    expect(sdk.messages.create).not.toHaveBeenCalled();
    await sender().enqueue(employeeId,{ kind:'template',templateKey:'leave_request',variables:{ employeeName:'María',requestReference:'folio-1' } },'template');
    await sender().processNext(); expect(sdk.messages.create).toHaveBeenCalledTimes(1);
    expect(sdk.messages.create.mock.calls[0][0].body).toBeUndefined(); expect(sdk.messages.create.mock.calls[0][0].contentSid).toBe(configuration.templates.leave_request.contentSid);
  });
  function inboundScope() { return { accountSid:configuration.accountSid,businessPhone:configuration.businessPhone,participantPhone:'+525555555552',providerMessageId:providerId(),body:'Hola',attachments:[] }; }

  it('keeps callbacks idempotent and monotonic, preserves error codes and flags contradictory terminal states', async () => {
    await receive(); const message = await sender().enqueue(employeeId,{ kind:'text',body:'Prueba de estados' },'states'); await sender().processNext();
    const attempt = (await rows('whatsapp_attempts'))[0];
    for (const state of ['sent','delivered','read','sent','read']) await status(attempt.provider_message_id,state,attempt.id);
    expect((await rows('whatsapp_messages')).find((row) => row.id===message.id)?.state).toBe('read');
    expect(await rows('whatsapp_delivery_events')).toHaveLength(4);
    await status(attempt.provider_message_id,'failed',attempt.id);
    expect((await rows('whatsapp_messages')).find((row) => row.id===message.id)?.state).toBe('reconciliation');
    expect((await rows('whatsapp_delivery_events')).some((row) => row.error_code==='63016')).toBe(true);
  });

  it('accepts a signed callback before the SDK response and does not downgrade delivered to queued', async () => {
    await receive();
    sendHook = async (input) => {
      const sid = providerId(); await status(sid,'delivered',new URL(input.statusCallback).searchParams.get('attemptId')!);
      return { sid,status:'queued' };
    };
    const message = await sender().enqueue(employeeId,{ kind:'text',body:'Carrera de callback' },'early'); await sender().processNext();
    expect((await rows('whatsapp_messages')).find((row) => row.id===message.id)?.state).toBe('delivered');
  });

  it('durably stores an unmatched callback and correlates it after the provider SID becomes available', async () => {
    await receive();
    sendHook = async () => {
      const sid = providerId(); await status(sid,'read');
      expect((await rows('whatsapp_delivery_events'))[0].attempt_id).toBeNull(); return { sid,status:'queued' };
    };
    const message = await sender().enqueue(employeeId,{ kind:'text',body:'Callback sin correlación' },'orphan'); await sender().processNext();
    expect((await rows('whatsapp_messages')).find((row) => row.id===message.id)?.state).toBe('read');
    expect((await rows('whatsapp_delivery_events')).every((row) => row.attempt_id!==null)).toBe(true);
  });

  it('does not attach a callback for a different recipient to an existing attempt', async () => {
    await receive(); const message = await sender().enqueue(employeeId,{ kind:'text',body:'Aislamiento' },'recipient'); await sender().processNext();
    const attempt = (await rows('whatsapp_attempts'))[0];
    await status(attempt.provider_message_id,'read',attempt.id,'whatsapp:+525555555551');
    expect((await rows('whatsapp_messages')).find((row) => row.id===message.id)?.state).toBe('queued');
    expect((await rows('whatsapp_delivery_events')).find((row) => row.provider_status==='read')?.attempt_id).toBeNull();
  });

  it('retries explicit rate-limit rejections with bounded backoff and stops after three attempts', async () => {
    await receive(); sendHook = async () => { throw { status:429,code:20429 }; };
    const message = await sender().enqueue(employeeId,{ kind:'text',body:'Reintento acotado' },'rate-limit');
    await sender().processNext(); expect(await sender().processNext()).toBe(false);
    now = new Date(now.getTime()+30000); await sender().processNext();
    now = new Date(now.getTime()+60000); await sender().processNext();
    expect(sdk.messages.create).toHaveBeenCalledTimes(3);
    expect((await rows('whatsapp_messages')).find((row) => row.id===message.id)?.state).toBe('failed');
    expect(await rows('whatsapp_attempts')).toHaveLength(3);
  });

  it('does not blindly retry an ambiguous timeout and can reconcile it using a later signed callback', async () => {
    await receive(); sendHook = async () => { throw { code:'ETIMEDOUT' }; };
    const message = await sender().enqueue(employeeId,{ kind:'text',body:'Timeout ambiguo' },'timeout'); await sender().processNext();
    now = new Date(now.getTime()+10*60000); await repository().recover(configuration,now);
    expect(await sender().processNext()).toBe(false); expect(sdk.messages.create).toHaveBeenCalledTimes(1);
    expect((await rows('whatsapp_messages')).find((row) => row.id===message.id)?.state).toBe('reconciliation');
    const attempt = (await rows('whatsapp_attempts'))[0]; await status(providerId(),'delivered',attempt.id);
    expect((await rows('whatsapp_messages')).find((row) => row.id===message.id)?.state).toBe('delivered');
  });

  it('recovers an interrupted send conservatively after restart and does not send it again', async () => {
    await receive(); await sender().enqueue(employeeId,{ kind:'text',body:'Proceso interrumpido' },'interrupted');
    expect(await repository().claimOutbound(configuration,now)).not.toBeNull();
    now = new Date(now.getTime()+120001); await repository().recover(configuration,now);
    expect(await sender().processNext()).toBe(false); expect(sdk.messages.create).not.toHaveBeenCalled();
    expect((await rows('whatsapp_attempts'))[0].state).toBe('uncertain');
  });

  it('does not resend after Twilio acceptance if persisting the receipt fails, and reconciles the interrupted attempt by callback', async () => {
    await receive(); let acceptedSid='';
    sendHook=async () => { acceptedSid=providerId(); return { sid:acceptedSid,status:'queued' }; };
    const message=await sender().enqueue(employeeId,{ kind:'text',body:'Confirmación pendiente de guardar' },'receipt-failure');
    await database.executeScript(`CREATE FUNCTION fail_whatsapp_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced_status_persistence_failure'; END; $$;
      CREATE TRIGGER fail_whatsapp_receipt BEFORE INSERT ON whatsapp_delivery_events FOR EACH ROW EXECUTE FUNCTION fail_whatsapp_receipt();`);
    try { await expect(sender().processNext()).rejects.toThrow(); }
    finally { await database.executeScript('DROP TRIGGER fail_whatsapp_receipt ON whatsapp_delivery_events; DROP FUNCTION fail_whatsapp_receipt();'); }
    expect(sdk.messages.create).toHaveBeenCalledTimes(1);
    expect((await rows('whatsapp_messages')).find((row) => row.id===message.id)?.state).toBe('sending');
    now=new Date(now.getTime()+120001); await repository().recover(configuration,now);
    expect(await sender().processNext()).toBe(false);
    const attempt=(await rows('whatsapp_attempts'))[0]; await status(acceptedSid,'delivered',attempt.id);
    expect((await rows('whatsapp_messages')).find((row) => row.id===message.id)?.state).toBe('delivered');
    expect(sdk.messages.create).toHaveBeenCalledTimes(1);
  });

  it('keeps the integration disabled by default without affecting the application health route', async () => {
    const disabled = await buildApp({ database });
    try {
      expect((await disabled.app.inject({ method:'POST',url:incomingWhatsAppPath,headers:{ 'content-type':'application/x-www-form-urlencoded' },payload:'' })).statusCode).toBe(503);
      expect((await disabled.app.inject({ method:'GET',url:'/health' })).statusCode).toBe(200);
      expect(disabled.whatsappWorker).toBeUndefined();
    } finally { await disabled.app.close(); }
    expect(await rows('whatsapp_messages')).toHaveLength(0);
  });
});
