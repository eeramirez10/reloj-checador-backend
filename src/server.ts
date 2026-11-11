import { buildApp } from './main.js';
import { env } from './infrastructure/config/env.js';
import { initializeOrganization } from './infrastructure/database/initialize-organization.js';

async function startServer(): Promise<void> {
  const { app, database, employeeNames, scheduler, whatsappWorker, emailWorker } = await buildApp();
  let closing = false;
  const shutdown = async (error?: unknown) => {
    if (closing) return;
    closing = true;
    if (error) { app.log.fatal({ err: error }, 'Error irrecuperable.'); process.exitCode = 1; }
    try { await app.close(); }
    catch (closeError) { app.log.error({ err: closeError }, 'No se pudo completar el cierre.'); process.exitCode = 1; }
  };
  try {
    await database.query('SELECT 1');
    await initializeOrganization(database);
    await employeeNames.populateMissing();
    await app.listen({ host: env.HOST, port: env.PORT });
    scheduler.start();
    if (!env.SYNC_ENABLED) app.log.info('Sincronización automática de relojes desactivada.');
    whatsappWorker?.start();
    emailWorker?.start();
    process.once('SIGINT', () => { void shutdown(); });
    process.once('SIGTERM', () => { void shutdown(); });
    process.once('uncaughtException', (error) => { void shutdown(error); });
    process.once('unhandledRejection', (error) => { void shutdown(error); });
  } catch (error) {
    await shutdown(error);
  }
}

void startServer().catch((error: unknown) => { console.error('No se pudo iniciar el servidor.', error); process.exitCode = 1; });
