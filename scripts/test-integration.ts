import { execFileSync } from 'node:child_process';
import { deployMigrations, withTemporaryDatabase } from './database-tools.js';

await withTemporaryDatabase('test_architecture', async (url) => {
  deployMigrations(url);
  execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...process.argv.slice(2)], {
    env: { ...process.env, APP_ENV: 'test', INTEGRATION_DATABASE_URL: url, DATABASE_URL: url }, stdio: 'inherit', timeout: 180_000,
  });
});
