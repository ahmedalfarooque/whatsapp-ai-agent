import type { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { isSuperAdmin, type AuthUser } from './permissions';
import { createProvider, deleteProvider, getSharedProvider, listSharedProviders, ProviderValidationError, reorderSharedProviders, setProviderEnabled, toView, updateProvider } from '../llm/providerRepo';
import { PROVIDER_PRESETS } from '../llm/providerPresets';
import { createInputFromSimple, defaultPoolSummary, fail, idParam, inputFrom, isSimpleBody, runProviderTest, updateInputFromSimple } from './aiRoutingRoutes';
import { env } from '../config/env';
import { csv } from '../llm/providerRepo';
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

export function registerSuperAdminAiRoutes(router: Router): void {
  router.get('/api/dashboard/super-admin/ai', (req, res) => {
    if (!requireSuper(req, res)) return;
    try {
      const key = getEffectiveCredential('OPENROUTER_API_KEY');
      const diag = describeCredential('OPENROUTER_API_KEY');
      res.json({
        providers: listSharedProviders().map(toView),
        presets: PROVIDER_PRESETS.map((p) => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, hint: p.hint, models: p.models })),
        pool: defaultPoolSummary(),
        accounts: accountCount(),
        // Server-level routes that are part of Default (configured on the server, shown here read-only; their keys are never returned).
        builtin: {
          openRouter: { hasKey: isUsableApiKey(key), source: diag.source },
          local: { configured: Boolean(env.OLLAMA_BASE_URL && csv(env.OLLAMA_MODELS).length), baseUrl: env.OLLAMA_BASE_URL ? env.OLLAMA_BASE_URL.replace(/\/\/[^/]+@/, '//') : '', models: csv(env.OLLAMA_MODELS) },
        },
        enforced: { freeOnly: true, failover: true, note: 'Strict free-only mode and automatic failover are on for every business by default; a paid or unknown-price route is never called while free-only is on.' },
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/api/dashboard/super-admin/ai/providers', (req, res) => {
    if (!requireSuper(req, res)) return;
    try {
      const input = isSimpleBody(req.body) ? createInputFromSimple(req.body) : inputFrom(req.body);
      const row = createProvider(input, { accountId: null, updatedBy: req.adminUserId as number });
      logger.info({ providerId: row.id, provider: row.name, kind: row.kind, adminUserId: req.adminUserId, accounts: accountCount() }, 'shared AI provider created');
      res.status(201).json({ provider: toView(row), pool: defaultPoolSummary() });
    } catch (error) {
      fail(res, error);
    }
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
