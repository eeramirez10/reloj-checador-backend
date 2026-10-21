import { buildApp } from './app.js';
import { env } from './config/env.js';
import { runMigrations } from './db/migrate.js';
import { SyncScheduler } from './sync/scheduler.js';
import { initializeOrganization } from './organization/initialize-organization.js';

const { app, database, devices, syncService, employeeNames } = await buildApp();
await runMigrations(database);
await initializeOrganization(database);
await employeeNames.populateMissing();
const scheduler = new SyncScheduler(devices, syncService, env.SYNC_INTERVAL_SECONDS);
scheduler.start();
app.addHook('onClose', async () => scheduler.stop());
await app.listen({ host: env.HOST, port: env.PORT });
