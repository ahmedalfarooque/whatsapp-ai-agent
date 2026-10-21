import type { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { isSuperAdmin, type AuthUser } from './permissions';
import { createProvider, deleteProvider, getSharedProvider, listSharedProviders, ProviderValidationError, reorderSharedProviders, setProviderEnabled, setProviderFreeConfirmed, toView, updateProvider } from '../llm/providerRepo';
import { providerActivity } from '../llm/routeLog';
import { providerHealth } from './aiPoolState';
import { presetsPayload } from '../llm/providerPresets';
import { defaultPoolSummary, fail, idParam, inputFrom, isSimpleBody, prepareCreateInput, recordSetupTest, runProviderTest, updateInputFromSimple } from './aiRoutingRoutes';
import { buildCandidates } from '../llm/aiRouter';
import { adoptBuiltinOpenRouter } from '../llm/adoptOpenRouter';
import { describeCredential, getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';

/**
 * Super Admin Settings — the shared AI defaults of the whole application. Only the permanent Super Admin may read or change anything here
 * (authorize.ts: the `super` rule, and checked again in every handler). The providers saved here form the shared "Default" pool every
 * business inherits — existing and future — without any key being copied into a business: a business sees only a one-line summary of
 * its Default entry and decides where Default sits in its own routing order. Keys are stored encrypted under the dashboard master key and
 * returned masked only. Removing a shared provider needs an explicit confirmation (the response says how many businesses inherit it).
 * Strict free-only mode and automatic failover are enforced for every business and are not switchable here.
 */
function requireSuper(req: Request, res: Response): boolean {
  if (isSuperAdmin((req.authUser as AuthUser | undefined) ?? null)) return true;
  res.status(403).json({ error: 'Only the Super Admin can manage the shared AI defaults', code: 'forbidden' });
  return false;
}

const accountCount = (): number => (getDb().prepare('SELECT COUNT(*) AS n FROM whatsapp_accounts').get() as { n: number }).n;

type DefaultState = 'ok' | 'failed' | 'untested' | 'none';

/**
 * Is there an eligible model in Default that has been tested? `eligibleRoutes` counts the routes a chat message could really use right now
 * (free under strict free-only mode, enabled, with a key, not cooling down); `state` combines that with the last test of the shared providers.
 * It is a statement about configuration and tests — never a claim that a customer reply works.
 */
async function defaultStatus(accountId: number): Promise<{ state: DefaultState; eligibleRoutes: number; detail: string }> {
  const plan = await buildCandidates(accountId, 'chat', { wantsTools: true });
  const shared = listSharedProviders();
  const sharedIds = new Set(shared.map((r) => r.id));
  const eligible = plan.eligible.filter((c) => c.builtin || (c.providerId !== null && sharedIds.has(c.providerId))).length;
  const tested = shared.filter((r) => r.last_test_at);
  const passed = tested.find((r) => r.last_test_ok === 1);
  const failed = tested.filter((r) => r.last_test_ok === 0).sort((a, b) => String(b.last_test_at).localeCompare(String(a.last_test_at)))[0];
  if (eligible === 0 && failed) return { state: 'failed', eligibleRoutes: 0, detail: `The last test of "${failed.name}" failed: ${failed.last_test_detail ?? 'see the provider'} No route is usable right now (a failed route rests for a while before it is tried again).` };
  if (eligible === 0) return { state: 'none', eligibleRoutes: 0, detail: shared.length ? 'No shared provider is usable right now: each one is turned off, has no key, is cooling down, or is not free.' : 'No shared provider is configured yet.' };
  if (passed) return { state: 'ok', eligibleRoutes: eligible, detail: `${eligible} eligible route${eligible === 1 ? '' : 's'}; "${passed.name}" passed its last test.` };
  if (failed) return { state: 'failed', eligibleRoutes: eligible, detail: `${eligible} eligible route${eligible === 1 ? '' : 's'}, but the last test of "${failed.name}" failed: ${failed.last_test_detail ?? 'see the provider'}` };
  return { state: 'untested', eligibleRoutes: eligible, detail: `${eligible} eligible route${eligible === 1 ? '' : 's'}, not tested yet. Press Test.` };
}

export function registerSuperAdminAiRoutes(router: Router): void {
  router.get('/api/dashboard/super-admin/ai', (req, res) => {
    if (!requireSuper(req, res)) return;
    void (async () => { try {
      const key = getEffectiveCredential('OPENROUTER_API_KEY');
      const diag = describeCredential('OPENROUTER_API_KEY');
      const next = (await buildCandidates(currentAccountId(), 'chat', { wantsTools: true })).eligible[0];
      const shared = listSharedProviders().map((r) => ({ ...toView(r), activity: providerActivity(r.id), health: providerHealth(r) }));
      // The provider that answered last (a fact from the routing history) and, while any provider is resting, the earliest moment one of them is tried again —
      // with whether that moment is a reset time the provider stated or only our own bounded backoff.
      const lastOk = getDb().prepare("SELECT provider_name AS provider, model, created_at AS answeredAt FROM ai_route_log WHERE task = 'chat' AND outcome = 'ok' AND provider_id IN (SELECT id FROM ai_providers WHERE whatsapp_account_id IS NULL) ORDER BY id DESC LIMIT 1").get() as { provider: string; model: string; answeredAt: string } | undefined;
      const retries = shared.filter((p) => p.health.cooldown).map((p) => ({ provider: p.name, ...p.health.cooldown! })).sort((a, b) => a.nextRetryAt.localeCompare(b.nextRetryAt));
      res.json({
        active: lastOk ? { provider: lastOk.provider, model: lastOk.model, answeredAt: `${lastOk.answeredAt.replace(' ', 'T')}Z` } : null,
        nextRetry: retries[0] ? { provider: retries[0].provider, at: retries[0].nextRetryAt, resetKnown: retries[0].resetKnown } : null,
        allResting: !next && retries.length > 0,
        status: await defaultStatus(currentAccountId()),
        // The route the next message would use first, by name only (never a key). Quota may change at any time: this is the plan, not a promise.
        nextRoute: next ? { provider: next.providerName, model: next.model } : null,
        providers: shared,
        ...presetsPayload(),
        pool: defaultPoolSummary(),
        accounts: accountCount(),
        // Server-level routes that are part of Default (configured on the server, shown here read-only; their keys are never returned).
        builtin: {
          openRouter: { hasKey: isUsableApiKey(key), source: diag.source, adopted: listSharedProviders().some((r) => r.kind === 'openrouter') },
        },
        enforced: { freeOnly: true, failover: true, note: 'Strict free-only mode and automatic failover are on for every business by default; a paid or unknown-price route is never called while free-only is on.' },
      });
    } catch (error) {
      fail(res, error);
    } })();
  });

  /** Adds the OpenRouter key already saved on this server to the shared Default pool as an ordinary provider (the key never leaves the server). */
  router.post('/api/dashboard/super-admin/ai/adopt-openrouter', (req, res) => {
    if (!requireSuper(req, res)) return;
    try {
      const result = adoptBuiltinOpenRouter(req.adminUserId as number);
      if (result.status === 'no_key') { res.status(409).json({ error: 'no_key', message: 'No usable OpenRouter key is saved on this server. Add one on Providers & Legacy API, or add a provider with its own key.' }); return; }
      logger.info({ providerId: result.provider?.id, status: result.status, adminUserId: req.adminUserId }, 'OpenRouter key adopted into the shared Default pool');
      res.status(result.status === 'created' ? 201 : 200).json({ status: result.status, provider: result.provider ? toView(result.provider) : null, pool: defaultPoolSummary() });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/api/dashboard/super-admin/ai/providers', (req, res) => {
    if (!requireSuper(req, res)) return;
    void (async () => {
      try {
        const prepared = await prepareCreateInput(req.body);
        if (!prepared.ok) { res.status(prepared.status).json(prepared.json); return; }
        const row = createProvider(prepared.input, { accountId: null, updatedBy: req.adminUserId as number });
        recordSetupTest(row, prepared.setup);
        logger.info({ providerId: row.id, provider: row.name, kind: row.kind, adminUserId: req.adminUserId, accounts: accountCount(), model: prepared.setup?.models[0] }, 'shared AI provider created');
        res.status(201).json({ provider: toView(getSharedProvider(row.id) ?? row), setup: prepared.setup ?? undefined, pool: defaultPoolSummary() });
      } catch (error) {
        fail(res, error);
      }
    })();
  });

  // Registered before the :id routes so "order" is never read as an id.
  router.put('/api/dashboard/super-admin/ai/providers/order', (req, res) => {
    if (!requireSuper(req, res)) return;
    try {
      const ids = (req.body as { ids?: unknown } | null)?.ids;
      if (!Array.isArray(ids) || ids.some((i) => !Number.isInteger(i))) { res.status(400).json({ error: 'validation_failed', fields: ['ids'] }); return; }
      reorderSharedProviders(ids as number[], req.adminUserId as number);
      logger.info({ adminUserId: req.adminUserId, order: ids }, 'shared AI provider order changed');
      res.json({ providers: listSharedProviders().map(toView) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.put('/api/dashboard/super-admin/ai/providers/:id', (req, res) => {
    if (!requireSuper(req, res)) return;
    try {
      const id = idParam(req);
      const existing = getSharedProvider(id);
      if (!existing) { res.status(404).json({ error: 'not_found' }); return; }
      const input = isSimpleBody(req.body) ? updateInputFromSimple(existing, req.body) : inputFrom(req.body);
      const row = updateProvider(id, currentAccountId(), input, req.adminUserId as number);
      logger.info({ providerId: row.id, provider: row.name, adminUserId: req.adminUserId, keyChanged: input.apiKey !== undefined }, 'shared AI provider updated');
      res.json({ provider: toView(row), pool: defaultPoolSummary() });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/api/dashboard/super-admin/ai/providers/:id/:action(enable|disable)', (req, res) => {
    if (!requireSuper(req, res)) return;
    try {
      const id = idParam(req);
      if (!getSharedProvider(id)) { res.status(404).json({ error: 'not_found' }); return; }
      const row = setProviderEnabled(id, currentAccountId(), req.params.action === 'enable', req.adminUserId as number);
      logger.info({ providerId: id, adminUserId: req.adminUserId, enabled: req.params.action === 'enable' }, 'shared AI provider switched');
      res.json({ provider: row ? toView(row) : null, pool: defaultPoolSummary() });
    } catch (error) {
      fail(res, error);
    }
  });

  /** The Super Admin states that this endpoint is on a free tier. Without it a non-OpenRouter provider is never routed under strict free-only mode. */
  router.post('/api/dashboard/super-admin/ai/providers/:id/:action(confirm-free|unconfirm-free)', (req, res) => {
    if (!requireSuper(req, res)) return;
    try {
      const id = idParam(req);
      if (!getSharedProvider(id)) { res.status(404).json({ error: 'not_found' }); return; }
      const confirmed = req.params.action === 'confirm-free';
      const row = setProviderFreeConfirmed(id, currentAccountId(), confirmed, req.adminUserId as number);
      logger.info({ providerId: id, confirmed, adminUserId: req.adminUserId }, 'shared AI provider free tier confirmation changed');
      res.json({ provider: row ? toView(row) : null, pool: defaultPoolSummary() });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/api/dashboard/super-admin/ai/providers/:id', (req, res) => {
    if (!requireSuper(req, res)) return;
    try {
      const id = idParam(req);
      const existing = getSharedProvider(id);
      if (!existing) { res.status(404).json({ error: 'not_found' }); return; }
      if (String(req.query.confirm ?? '') !== 'yes') {
        res.status(409).json({ error: 'confirmation_required', message: `Removing "${existing.name}" and its stored key affects every business that uses Default (${accountCount()} now). Repeat the request with confirm=yes to remove it.`, accounts: accountCount() });
        return;
      }
      deleteProvider(id, currentAccountId());
      logger.info({ providerId: id, provider: existing.name, adminUserId: req.adminUserId }, 'shared AI provider removed');
      res.json({ ok: true, pool: defaultPoolSummary() });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/api/dashboard/super-admin/ai/providers/:id/test', async (req, res) => {
    if (!requireSuper(req, res)) return;
    try {
      const id = idParam(req);
      const row = getSharedProvider(id);
      if (!row) { res.status(404).json({ error: 'not_found' }); return; }
      const result = await runProviderTest(row);
      res.json({ ...result, provider: toView(getSharedProvider(id)!) });
    } catch (error) {
      if (error instanceof ProviderValidationError) { fail(res, error); return; }
      fail(res, error);
    }
  });
}
