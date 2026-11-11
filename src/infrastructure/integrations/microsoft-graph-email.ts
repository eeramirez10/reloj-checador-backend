import { EmailSendError, type EmailContent, type EmailGateway } from '../../domain/datasources/email-gateway.js';

interface GraphSettings { tenantId: string; clientId: string; clientSecret: string; senderId: string }
export class MicrosoftGraphEmail implements EmailGateway {
  private token?: { value: string; until: number };
  constructor(private readonly settings: GraphSettings, private readonly request: typeof fetch = fetch) {}

  private async accessToken() {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    let response: Response;
    try {
      response = await this.request(`https://login.microsoftonline.com/${encodeURIComponent(this.settings.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',body: new URLSearchParams({ client_id: this.settings.clientId,client_secret: this.settings.clientSecret,scope: 'https://graph.microsoft.com/.default',grant_type: 'client_credentials' }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new EmailSendError('retryable','TOKEN_UNAVAILABLE'); }
    if (!response.ok) throw new EmailSendError(response.status === 429 || response.status >= 500 ? 'retryable' : 'permanent',`TOKEN_HTTP_${response.status}`);
    const body = await response.json() as { access_token: string; expires_in: number };
    if (!body.access_token || !Number.isFinite(body.expires_in)) throw new EmailSendError('permanent','INVALID_TOKEN_RESPONSE');
    this.token = { value: body.access_token,until: Date.now() + Math.max(0,body.expires_in - 60) * 1000 };
    return this.token.value;
  }

  async send(recipient: string, content: EmailContent) {
    const token = await this.accessToken();
    let response: Response;
    try {
      response = await this.request(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.settings.senderId)}/sendMail`, {
        method: 'POST',headers: { authorization: `Bearer ${token}`,'content-type': 'application/json' },
        body: JSON.stringify({ message: { subject: content.subject,body: { contentType: 'Text',content: content.text },toRecipients: [{ emailAddress: { address: recipient } }] },saveToSentItems: true }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new EmailSendError('uncertain','SEND_UNCONFIRMED'); }
    if (response.status === 202) return;
    if (response.status === 401) { this.token = undefined; throw new EmailSendError('retryable','GRAPH_HTTP_401'); }
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.ceil((Date.parse(retry)-Date.now())/1000) : 60;
      throw new EmailSendError('retryable','GRAPH_HTTP_429',Number.isFinite(seconds) ? Math.max(1,seconds) : 60);
    }
    throw new EmailSendError(response.status >= 500 ? 'uncertain' : 'permanent',`GRAPH_HTTP_${response.status}`);
  }
}
