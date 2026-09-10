import { env } from './config/env';
import { logger } from './logger';
import { createApp } from './app';
import { getDb, closeDb } from './memory/db';

// Ensure the database is initialized (and migrations applied) at boot,
// before the server starts accepting traffic.
getDb();

if (env.shouldUseMockProviders) {
  logger.warn('Development mode: using mock WhatsApp provider — no real messages will be sent');
  logger.warn('Development mode: using mock LLM provider — no real OpenRouter calls will be made');
  logger.warn('Development mode: using mock Calendar provider — no real Google Calendar calls will be made');
} else {
  logger.info('Production mode: using real WhatsApp, OpenRouter, and Google Calendar providers');
}

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
