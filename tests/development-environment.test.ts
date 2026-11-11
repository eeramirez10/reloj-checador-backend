import { describe, expect, it } from 'vitest';
import { databaseForEnvironment } from '../src/infrastructure/config/database-environment.js';
import { parseEnvironment } from '../src/infrastructure/config/env.js';

const production = 'postgresql://owner:example@ep-production.us-east-2.aws.neon.tech/neondb';
const development = 'postgresql://owner:example@ep-development.us-east-2.aws.neon.tech/neondb';
describe('development database and background isolation', () => {
  it('refuses production access even when credentials or TLS parameters differ', () => {
    expect(() => databaseForEnvironment({ APP_ENV: 'development', DATABASE_URL: production.replace('owner:example', 'other:credentials') + '?sslmode=require', PRODUCTION_DATABASE_URL: production })).toThrow('producción');
    expect(() => databaseForEnvironment({ APP_ENV: 'development', DATABASE_URL: production.replace('ep-production.', 'ep-production-pooler.'), PRODUCTION_DATABASE_URL: production })).toThrow('producción');
    expect(() => databaseForEnvironment({ APP_ENV: 'development', DATABASE_URL: development })).toThrow('PRODUCTION_DATABASE_URL');
  });
  it('allows a separate branch with automatic synchronization and WhatsApp disabled', () => {
    const configuration = parseEnvironment({ APP_ENV: 'development', DATABASE_URL: development, PRODUCTION_DATABASE_URL: production, SYNC_ENABLED: 'false', TWILIO_WHATSAPP_ENABLED: 'false' });
    expect(configuration.SYNC_ENABLED).toBe(false);
    expect(configuration.DATABASE_URL).toBe(development);
  });
  it('rejects background processing accidentally enabled in development', () => {
    const input = { APP_ENV: 'development', DATABASE_URL: development, PRODUCTION_DATABASE_URL: production };
    expect(() => parseEnvironment(input)).toThrow('SYNC_ENABLED');
    expect(() => parseEnvironment({ ...input, SYNC_ENABLED: 'false', TWILIO_WHATSAPP_ENABLED: 'true' })).toThrow();
    expect(() => parseEnvironment({ ...input,SYNC_ENABLED: 'false',EMAIL_ENABLED: 'true',EMAIL_ENCRYPTION_KEY: 'ab'.repeat(32),MICROSOFT_TENANT_ID: 'test-tenant',MICROSOFT_CLIENT_ID: 'test-client',MICROSOFT_CLIENT_SECRET: 'test-secret',MICROSOFT_SENDER_ID: 'test-mailbox' })).toThrow('EMAIL_ENABLED');
  });
  it('preserves production defaults and supports isolated integration-test databases', () => {
    expect(parseEnvironment({ DATABASE_URL: production }).SYNC_ENABLED).toBe(true);
    expect(parseEnvironment({ APP_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost:5435/test_isolated' }).APP_ENV).toBe('test');
  });
});
