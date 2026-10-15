import { Router, type Request, type Response } from 'express';
import { getDb } from '../memory/db';
import { logger } from '../logger';
import { listEnabledAccounts } from '../accounts/accountRepo';
import { heartbeat } from './heartbeat';
import { buildCandidates } from '../llm/aiRouter';
import { routeStats } from '../llm/routeLog';

/** Per enabled business: how many AI routes could take a chat message right now, and how the last hour went (counts only, no secrets). */
async function aiHealth(accountIds: number[]): Promise<{ status: 'ok' | 'degraded'; accounts: Array<{ id: number; eligibleRoutes: number; lastHour: { ok: number; failed: number } }>; noEligibleRoute: number[] }> {
  const accounts: Array<{ id: number; eligibleRoutes: number; lastHour: { ok: number; failed: number } }> = [];
  for (const id of accountIds) {
    try {
      const plan = await buildCandidates(id, 'chat', { wantsTools: true });
      const totals = routeStats(id, 1).totals;
      accounts.push({ id, eligibleRoutes: plan.eligible.length, lastHour: { ok: totals.ok, failed: totals.failed } });
    } catch {
      accounts.push({ id, eligibleRoutes: 0, lastHour: { ok: 0, failed: 0 } });
    }
  }
  const noEligibleRoute = accounts.filter((a) => a.eligibleRoutes === 0).map((a) => a.id);
  return { status: noEligibleRoute.length ? 'degraded' : 'ok', accounts, noEligibleRoute };
}

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
  router.get('/readiness', async (_req: Request, res: Response) => {
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
    // An unavailable AI provider is reported, not hidden: with no eligible route a customer gets the automated choices and the message waits for a safe replay.
    const ai = await aiHealth(accounts.map((a) => a.id));
    res.status(200).json({
      status: notConnected.length || ai.status === 'degraded' ? 'degraded' : 'ready',
      accounts,
      notConnected,
      ai,
      workers: heartbeat(),
    });
  });

  return router;
}
