import { env } from './config/env';
import { logger } from './logger';
import { createApp } from './app';
import { getDb, closeDb } from './memory/db';

// Ensure the database is initialized (and migrations applied) at boot,
// before the server starts accepting traffic.
getDb();

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'WhatsApp AI agent listening');
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'received shutdown signal, closing gracefully');

  server.close((err) => {
    if (err) {
      logger.error({ error: err }, 'error while closing HTTP server');
    }
    try {
      closeDb();
    } catch (error) {
      logger.error({ error }, 'error while closing database connection');
    }
    logger.info('shutdown complete');
    process.exit(err ? 1 : 0);
  });

  // Force-exit if graceful shutdown hangs (e.g. a stuck in-flight request).
  setTimeout(() => {
    logger.warn('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled promise rejection');
});
process.on('uncaughtException', (error) => {
  logger.error({ error }, 'uncaught exception');
});
