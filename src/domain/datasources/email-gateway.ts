export interface EmailContent { subject: string; text: string }
export interface EmailGateway { send(recipient: string, content: EmailContent): Promise<void> }
export class EmailSendError extends Error {
  constructor(readonly kind: 'retryable' | 'permanent' | 'uncertain', readonly code: string, readonly retryAfterSeconds = 60) { super(code); }
}
