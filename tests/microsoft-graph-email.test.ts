import { describe,expect,it,vi } from 'vitest';
import { MicrosoftGraphEmail } from '../src/infrastructure/integrations/microsoft-graph-email.js';
import { EmailContentCipher } from '../src/infrastructure/integrations/email-content-cipher.js';

describe('Microsoft Graph mail transport',() => {
  const settings = { tenantId:'test-tenant',clientId:'test-client',clientSecret:'test-secret',senderId:'test-sender' };
  it('uses app-only OAuth, scopes the request to the configured mailbox and reuses the token',async () => {
    const request = vi.fn(async (url: string | URL | Request,options?: RequestInit) => {
      if (String(url).includes('/token')) {
        expect(String(options?.body)).toContain('grant_type=client_credentials');
        return new Response(JSON.stringify({ access_token:'test-access-token',expires_in:3600 }),{status:200});
      }
      expect(String(url)).toBe('https://graph.microsoft.com/v1.0/users/test-sender/sendMail');
      const body = JSON.parse(String(options?.body));
      expect(body.message.toRecipients).toEqual([{emailAddress:{address:'recipient@example.test'}}]);
      expect(body.saveToSentItems).toBe(true);
      return new Response(null,{status:202});
    }) as unknown as typeof fetch;
    const gateway = new MicrosoftGraphEmail(settings,request);
    await gateway.send('recipient@example.test',{subject:'Test',text:'Body'});
    await gateway.send('recipient@example.test',{subject:'Test',text:'Body'});
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('distinguishes throttling, ambiguous sends and permanent failures',async () => {
    for (const [status,kind] of [[429,'retryable'],[503,'uncertain'],[403,'permanent']] as const) {
      const request = vi.fn(async (url: string | URL | Request) => String(url).includes('/token')
        ? new Response(JSON.stringify({access_token:'token',expires_in:3600}),{status:200}) : new Response(null,{status,headers:{'retry-after':'120'}})) as unknown as typeof fetch;
      await expect(new MicrosoftGraphEmail(settings,request).send('recipient@example.test',{subject:'Test',text:'Body'})).rejects.toMatchObject({kind,code:`GRAPH_HTTP_${status}`});
    }
  });
  it('binds encrypted credentials to their queue entry and rejects tampering',() => {
    const cipher = new EmailContentCipher('ab'.repeat(32));
    const content = {subject:'Access',text:'temporary-secret'};
    const encrypted = cipher.encrypt(content,'message-one');
    expect(encrypted).not.toContain(content.text);
    expect(cipher.decrypt(encrypted,'message-one')).toEqual(content);
    expect(() => cipher.decrypt(encrypted,'message-two')).toThrow();
  });
});
