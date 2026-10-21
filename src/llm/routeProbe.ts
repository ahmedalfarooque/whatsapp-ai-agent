import { env } from '../config/env';
import { logger } from '../logger';
import { getDb } from '../memory/db';
import { runWithAccount } from '../accounts/accountContext';
import { buildCandidates, routeCompletion, type RouteCandidate } from './aiRouter';
import { vendorForUrl } from './adapters';
import { validationBudget } from './validationBudget';

/**
 * Bounded recovery probes. When a route failed and its cooldown has ended, the next real customer message would be the one to find out whether
 * it works again. A probe finds out first, with ONE tiny completion (a neutral prompt, no customer data, 8 tokens), so a customer is not the
 * test. Limits: only routes whose LAST observed attempt was a failure; at most one probe per route per PROBE_INTERVAL_MS; at most MAX_PER_PASS
 * per pass; only routes that strict free-only mode and the business's order already allow (it uses the router's own eligibility); never
 * when mock providers are on. A probe that fails puts the route back into its cooldown, so an exhausted provider is never hammered.
 */
export const PROBE_INTERVAL_MS = 10 * 60_000;
export const MAX_PER_PASS = 2;
const lastProbe = new Map<string, number>();

export function resetRouteProbesForTests(): void { lastProbe.clear(); }

/** Did the last logged attempt on this route fail? (no history = nothing to recover, nothing to probe) */
function lastAttemptFailed(candidate: RouteCandidate, db = getDb()): boolean {
  const row = candidate.providerId !== null
    ? db.prepare("SELECT outcome FROM ai_route_log WHERE provider_id = ? AND model = ? AND outcome IN ('ok','failed') ORDER BY id DESC LIMIT 1").get(candidate.providerId, candidate.model) as { outcome: string } | undefined
    : db.prepare("SELECT outcome FROM ai_route_log WHERE provider_id IS NULL AND model = ? AND outcome IN ('ok','failed') ORDER BY id DESC LIMIT 1").get(candidate.model) as { outcome: string } | undefined;
  return row?.outcome === 'failed';
}

export async function probeRecoveredRoutes(now: number = Date.now(), db = getDb()): Promise<{ probed: number }> {
  if (env.shouldUseMockProviders) return { probed: 0 };
  const accounts = db.prepare('SELECT id FROM whatsapp_accounts ORDER BY id').all() as Array<{ id: number }>;
  const done = new Set<string>();
  let probed = 0;
  for (const account of accounts) {
    if (probed >= MAX_PER_PASS) break;
    const plan = await runWithAccount(account.id, () => buildCandidates(account.id, 'chat', { wantsTools: false, now }));
    for (const candidate of plan.eligible) {
      if (probed >= MAX_PER_PASS) break;
      // Shared providers and the built-in key are one route for every business: probe each once per pass, not once per business.
      if (done.has(candidate.key) || !candidate.apiKey) continue;
      done.add(candidate.key);
      if (!lastAttemptFailed(candidate, db)) continue;
      if (now - (lastProbe.get(candidate.key) ?? 0) < PROBE_INTERVAL_MS) continue;
      lastProbe.set(candidate.key, now);
      probed += 1;
      try {
        await runWithAccount(account.id, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: validationBudget(vendorForUrl(candidate.baseUrl).id, candidate.baseUrl).first, temperature: 0, deadline: now + 30_000, candidatesOverride: [candidate] }));
        logger.info({ provider: candidate.providerName, model: candidate.model }, '[AI-PROBE] route answered again');
      } catch {
        logger.info({ provider: candidate.providerName, model: candidate.model }, '[AI-PROBE] route still unavailable (cooldown set again)');
      }
    }
  }
  return { probed };
}

export function startRouteProbes(): void {
  setInterval(() => { void probeRecoveredRoutes().catch((error) => logger.warn({ errorName: (error as Error)?.name }, '[AI-PROBE] pass failed')); }, 2 * 60_000).unref();
}
