import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'dotenv';
import { afterEach, describe, expect, it } from 'vitest';

const integration = process.env.INTEGRATION_DATABASE_URL ? describe : describe.skip;
const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/configure-development.ts', import.meta.url));
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const production = 'postgresql://example:example@ep-production.us-east-2.aws.neon.tech/neondb';

integration('development configuration activation', () => {
  const directories: string[] = [];
  afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

  async function configuration(contents: string) {
    const directory = await mkdtemp(join(tmpdir(), 'test-development-config-'));
    directories.push(directory);
    await writeFile(join(directory, '.env'), contents, { mode: 0o600 });
    return directory;
  }
  function run(directory: string, args: string[] = []) {
    return execute(process.execPath, ['--import', loader, script, ...args], { cwd: directory, timeout: 30000 });
  }

  it('selects an independent database, disables jobs and preserves the original configuration', async () => {
    const original = `DATABASE_URL=${production}\r\nDEVELOPMENT_DATABASE_URL=${process.env.INTEGRATION_DATABASE_URL}\r\nEXTRA_SETTING=keep-me\r\nAUTH_COOKIE_SECURE=true\r\n`;
    const directory = await configuration(original);
    const result = JSON.parse((await run(directory)).stdout);
    const updated = parse(await readFile(join(directory, '.env'), 'utf8'));
    expect(updated.DATABASE_URL).toBe(process.env.INTEGRATION_DATABASE_URL);
    expect(updated.PRODUCTION_DATABASE_URL).toBe(production);
    expect(updated.APP_ENV).toBe('development');
    expect(updated.SYNC_ENABLED).toBe('false');
    expect(updated.TWILIO_WHATSAPP_ENABLED).toBe('false');
    expect(updated.EMAIL_ENABLED).toBe('false');
    expect(updated.AUTH_COOKIE_SECURE).toBe('false');
    expect(updated.EXTRA_SETTING).toBe('keep-me');
    expect(result.developmentDatabaseActivated).toBe(true);
    expect(await readFile(result.previousConfiguration, 'utf8')).toBe(original);
  });
  it('refuses to select production without rewriting the environment file', async () => {
    const original = `DATABASE_URL=${production}\nDEVELOPMENT_DATABASE_URL=${production}\n`;
    const directory = await configuration(original);
    await expect(run(directory)).rejects.toThrow('Desarrollo no puede utilizar la base de producción');
    expect(await readFile(join(directory, '.env'), 'utf8')).toBe(original);
  });
  it('can prepare a blocked development environment before receiving the branch connection', async () => {
    const directory = await configuration(`DATABASE_URL=${production}\n`);
    const result = JSON.parse((await run(directory, ['--prepare-only'])).stdout);
    const updated = parse(await readFile(join(directory, '.env'), 'utf8'));
    expect(updated.DATABASE_URL).toBe(production);
    expect(updated.PRODUCTION_DATABASE_URL).toBe(production);
    expect(updated.APP_ENV).toBe('development');
    expect(updated.SYNC_ENABLED).toBe('false');
    expect(result.developmentDatabaseActivated).toBe(false);
  });
});
