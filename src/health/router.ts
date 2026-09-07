import { Router, type Request, type Response } from 'express';
import { getDb } from '../memory/db';
import { logger } from '../logger';

export function createHealthRouter(): Router {
  const router = Router();

  // Liveness — process is up and responding. Used by Docker HEALTHCHECK.
  router.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // Readiness — critical dependencies (SQLite) are reachable.
  router.get('/readiness', (_req: Request, res: Response) => {
    try {
      getDb().prepare('SELECT 1').get();
      res.status(200).json({ status: 'ready' });
    } catch (error) {
      logger.error({ error }, 'readiness check failed: database unreachable');
      res.status(503).json({ status: 'not_ready', reason: 'database_unreachable' });
    }
  });

  return router;
}
