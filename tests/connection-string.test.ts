import { describe,expect,it } from 'vitest';
import { connectionString } from '../src/infrastructure/database/connection-string.js';
describe('PostgreSQL connection settings',()=>{
  it('requires verified TLS for Neon while preserving other connection parameters',()=>{
    const url = new URL(connectionString('postgresql://user:password@ep-test.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require&options=-c%20search_path%3Dcustom'));
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(url.searchParams.get('channel_binding')).toBe('require');
    expect(url.searchParams.get('options')).toBe('-c search_path=custom');
  });
  it('rejects a pooler connection instead of silently losing session search_path settings',()=>{
    expect(()=>connectionString('postgresql://user:password@ep-test-pooler.us-east-2.aws.neon.tech/neondb')).toThrow('directa');
  });
  it('keeps local PostgreSQL connections compatible with isolated test schemas',()=>{
    const input='postgresql://user:password@127.0.0.1:5435/test_database?options=-c%20search_path%3Dtest_schema';
    expect(connectionString(input)).toBe(input);
  });
});
