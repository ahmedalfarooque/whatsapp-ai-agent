import { Router, type Request, type Response } from 'express';
import { getDb } from '../memory/db';
import { logger } from '../logger';
import { listEnabledAccounts } from '../accounts/accountRepo';
import { heartbeat } from './heartbeat';

export function createHealthRouter(): Router {
  const router = Router();

  // Liveness — process is up and responding. Used by Docker HEALTHCHECK.
  router.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  /**
   * Readiness — critical dependencies (SQLite) are reachable (503 otherwise), plus the facts an operator needs to tell "up" from "working":
   * every enabled WhatsApp account's persisted connection state (a disconnected account cannot receive messages and is reported as such,
   * never as ready) and the worker heartbeat (when a customer message was last received and finished). `status` is 'ready' when every
   * enabled account is connected, 'degraded' when at least one is not; both answer 200 because the process itself is serving.
   */
  router.get('/readiness', (_req: Request, res: Response) => {
    try {
      getDb().prepare('SELECT 1').get();
    } catch (error) {
      logger.error({ error }, 'readiness check failed: database unreachable');
      res.status(503).json({ status: 'not_ready', reason: 'database_unreachable' });
      return;
    }
    let accounts: Array<{ id: number; status: string; connected: boolean }> = [];
    try {
      accounts = listEnabledAccounts().map((a) => ({ id: a.id, status: a.status, connected: a.status === 'connected' }));
    } catch {
      /* a database from before the multi-account migration: no account table yet */
    }
    const notConnected = accounts.filter((a) => !a.connected).map((a) => a.id);
    res.status(200).json({
      status: notConnected.length ? 'degraded' : 'ready',
      accounts,
      notConnected,
      workers: heartbeat(),
    });
  });

  return router;
}
