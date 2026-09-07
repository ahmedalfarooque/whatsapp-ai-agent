import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import pinoHttp from 'pino-http';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { env } from './config/env';
import { logger } from './logger';
import { rawBodySaver } from './webhook/verifySignature';
import { createWebhookRouter } from './webhook/router';
import { createHealthRouter } from './health/router';
import { loadKnowledgeBase } from './knowledge/loader';
import path from 'node:path';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/readiness' },
    }),
  );

  app.use(createHealthRouter());

  const webhookLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.RATE_LIMIT_PER_MINUTE,
    standardHeaders: true,
    legacyHeaders: false,
  });

  const knowledgeDir = path.join(__dirname, '..', 'knowledge');
  const knowledge = loadKnowledgeBase(knowledgeDir);

  app.use(
    '/webhook',
    webhookLimiter,
    express.json({ limit: env.MAX_BODY_SIZE, verify: rawBodySaver }),
  );
  app.use(createWebhookRouter({ knowledge }));

  // Centralized error handler — never leak stack traces/secrets to clients.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error & { type?: string; status?: number }, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;

    // Malformed/oversized request bodies are client errors, not server errors.
    if (err.type === 'entity.parse.failed') {
      logger.warn({ path: req.path }, 'rejected request: malformed JSON body');
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    if (err.type === 'entity.too.large') {
      logger.warn({ path: req.path }, 'rejected request: body too large');
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }

    logger.error({ error: err, path: req.path }, 'unhandled application error');
    res.status(500).json({ error: 'internal_server_error' });
  });

  return app;
}
