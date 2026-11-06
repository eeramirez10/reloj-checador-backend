import { randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import type { PasswordHasher } from '../../domain/repositories/auth-repository.js';

const options = { m: 19456, t: 2, p: 1, dkLen: 32 };

export class ArgonPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await argon2idAsync(password, salt, options);
    return `$argon2id$v=19$m=${options.m},t=${options.t},p=${options.p}$${salt.toString('base64')}$${Buffer.from(derived).toString('base64')}`;
  }

  async verify(encoded: string, password: string): Promise<boolean> {
    const parts = encoded.split('$');
    const valid = parts.length === 6 && parts[1] === 'argon2id' && parts[2] === 'v=19' && parts[3] === `m=${options.m},t=${options.t},p=${options.p}`;
    const salt = valid ? Buffer.from(parts[4], 'base64') : Buffer.alloc(16);
    const expected = valid ? Buffer.from(parts[5], 'base64') : Buffer.alloc(32);
    const derived = Buffer.from(await argon2idAsync(password, salt.length === 16 ? salt : Buffer.alloc(16), options));
    return valid && expected.length === 32 && timingSafeEqual(derived, expected);
  }
}
