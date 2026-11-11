import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EmailContent } from '../../domain/datasources/email-gateway.js';
import { ConfigurationError } from '../../domain/errors/app-error.js';

export class EmailContentCipher {
  private readonly key: Buffer;
  constructor(key: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new ConfigurationError('Configura EMAIL_ENCRYPTION_KEY antes de generar accesos o correos.');
    this.key = Buffer.from(key,'hex');
  }
  encrypt(content: EmailContent, id: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(content),'utf8'),cipher.final()]);
    return [iv,cipher.getAuthTag(),encrypted].map(part => part.toString('base64')).join('.');
  }
  decrypt(content: string, id: string): EmailContent {
    const [iv,tag,data] = content.split('.').map(part => Buffer.from(part,'base64'));
    const decipher = createDecipheriv('aes-256-gcm',this.key,iv);
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8')) as EmailContent;
  }
}
