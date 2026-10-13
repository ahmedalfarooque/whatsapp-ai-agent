import { env } from './config/env';
import { logger } from './logger';
import { createApp } from './app';
import { getDb, closeDb } from './memory/db';
import { resumeQrConnection, closeQrConnection } from './whatsapp/qrConnection';
import { seedBusinessProfileDefaults } from './config/businessSettings';
import { flushOutbox } from './notifications/outbox';
import { expireDueQuotations } from './quotations/quotationExpiry';
import { recoverInterruptedEvents } from './memory/webhookEventRepo';
import { recordReplyActivity } from './automation/settingsRepo';
import { LEGACY_ACCOUNT_ID } from './accounts/accountContext';
import { recoverStaleJobs, startScheduler } from './jobs/scheduler';
import { registerFollowupJobs } from './followups/followupService';

// Ensure the database is initialized (and migrations applied) at boot,
// before the server starts accepting traffic.
getDb();
{
  const seeded = seedBusinessProfileDefaults();
  if (seeded.length) logger.info({ columns: seeded }, 'business profile defaults seeded for columns the dashboard had not set');
  // A message whose processing was cut short by the previous shutdown is recorded as a failure (visible to staff), never left as silence.
  const interrupted = recoverInterruptedEvents();
  for (const messageId of interrupted) {
    const account = /^qr:(\d+):/.exec(messageId)?.[1];
    recordReplyActivity({ accountId: account ? Number(account) : LEGACY_ACCOUNT_ID, channel: messageId.startsWith('qr') ? 'qr' : 'cloud', kind: 'error', detail: 'Message processing was interrupted by a restart before a reply was recorded — not answered; check the conversation' });
  }
  if (interrupted.length) logger.warn({ count: interrupted.length }, 'inbound events interrupted by the previous shutdown were marked failed');
  // Durable reminders / eligibility / overdue checks for follow-up requests: rows survive restarts; a job cut short mid-run is re-queued.
  registerFollowupJobs();
  const stale = recoverStaleJobs();
  if (stale) logger.warn({ count: stale }, 'scheduled jobs interrupted by the previous shutdown were re-queued');
}

if (env.loginOtpEnabled && !(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL)) {
  logger.warn('RESEND_OTP_ENABLED is on but RESEND_API_KEY / RESEND_FROM_EMAIL are not set: dashboard sign-in will refuse to proceed until they are (fail closed)');
} else if (env.loginOtpEnabled) {
  logger.info('Dashboard sign-in requires an emailed one-time code after the password (Resend)');
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

// Due follow-up reminders, eligibility and overdue checks run from the scheduled_jobs table every 15 s (and shortly after boot).
startScheduler();

// Sent quotations whose validity date has passed (in each business's own timezone) are expired quietly: at start-up and then hourly.
const runQuotationExpiry = (): void => { try { expireDueQuotations(); } catch (error) { logger.warn({ error }, '[QUOTATION] expiry run failed'); } };
setTimeout(runQuotationExpiry, 20_000).unref();
setInterval(runQuotationExpiry, 60 * 60_000).unref();

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
