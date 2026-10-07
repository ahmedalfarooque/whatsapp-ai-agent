import { env } from './config/env';
import { logger } from './logger';
import { createApp } from './app';
import { getDb, closeDb } from './memory/db';
import { resumeQrConnection, closeQrConnection } from './whatsapp/qrConnection';
import { seedBusinessProfileDefaults } from './config/businessSettings';
import { flushOutbox } from './notifications/outbox';

// Ensure the database is initialized (and migrations applied) at boot,
// before the server starts accepting traffic.
getDb();
{
  const seeded = seedBusinessProfileDefaults();
  if (seeded.length) logger.info({ columns: seeded }, 'business profile defaults seeded for columns the dashboard had not set');
}

if (env.shouldUseMockProviders) {
  logger.warn('Development mode: using mock WhatsApp provider — no real messages will be sent');
  logger.warn('Development mode: using mock LLM provider — no real OpenRouter calls will be made');
  logger.warn('Development mode: using mock Calendar provider — no real Google Calendar calls will be made');
} else {
  logger.info(
    { whatsappConnectionMethod: env.whatsappConnectionMethod },
    env.usesMetaCloudApi
      ? 'Production mode: using Meta WhatsApp Cloud API, real OpenRouter, and Google Calendar providers'
      : 'Production mode: using WhatsApp QR (Baileys) transport, real OpenRouter, and Google Calendar providers',
  );
}

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'WhatsApp AI agent listening');
  // Every enabled WhatsApp account resumes its own saved session independently.
  resumeQrConnection();
});

// Pending WhatsApp notifications (staff alerts, customer confirmations) are retried every 30 s
// and immediately after the session reconnects; the dashboard never waits on delivery.
setInterval(() => { void flushOutbox().catch((error) => logger.warn({ error }, '[OUTBOX] periodic flush failed')); }, 30_000).unref();

// A second instance must die immediately: two processes sharing one Baileys
// auth store desync the Signal sessions and every inbound message becomes
// undecryptable ("Bad MAC"). Never keep a WhatsApp socket alive without the port.
server.on('error', (error: NodeJS.ErrnoException) => {
  logger.fatal({ error: error.code ?? error.message, port: env.PORT }, 'HTTP server failed to bind — exiting to avoid a duplicate WhatsApp session');
  void closeQrConnection().finally(() => process.exit(1));
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  void closeQrConnection();
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
