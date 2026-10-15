import type { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { currentAccountId } from '../accounts/accountContext';
import { env } from '../config/env';
import { getBusinessSettings, updateBusinessSettings } from '../config/businessSettings';
import { describeCredential, getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { isSuperAdmin, type AuthUser } from './permissions';
import { activeCooldowns, BUILTIN_OPENROUTER_PRIORITY, buildCandidates, explainRoutes, routeCompletion, type RouteCandidate } from '../llm/aiRouter';
import { AiCredentialError } from '../llm/aiCredentialError';
import { AiResponseError } from '../llm/aiResponseError';
import { getModelInfo } from '../llm/modelCatalog';
import { createProvider, csv, deleteProvider, getProvider, listProvidersForAccount, listSharedProviders, PROVIDER_KINDS, providerApiKey, ProviderValidationError, recordProviderTest, setProviderEnabled, toView, updateProvider, type AiProviderInput, type AiProviderRow, type ProviderKind } from '../llm/providerRepo';
import { PROVIDER_PRESETS, resolveSimpleProvider, SimpleProviderError } from '../llm/providerPresets';
import { getAccountRouting, RoutingOrderError, saveAccountRouting } from '../llm/routingOrder';
import { listRouteLog, routeStats } from '../llm/routeLog';
import { pendingReplyCounts } from '../replay/pendingReplyRepo';
import { listEscalations } from '../escalation/escalationService';
import { voiceCallCapability } from '../escalation/voiceCall';

/**
 * AI routing administration for the SELECTED account (authorize.ts: the "configuration" capability).
 *
 * A business sees a short ordered list: the single "Default" entry (the shared provider pool the Super Admin manages — only a summary is
 * returned, never a name's key or any secret) and its OWN providers. The order is saved per business and is what the router really uses.
 * Own providers are added with a name and an API configuration; a key is written once and never read back (the API returns `hasKey` and a
 * masked preview). Shared providers are managed only by the Super Admin (superAdminAiRoutes.ts). Test calls use one tiny completion
 * (max 8 tokens), are recorded on the provider and in the route log, and never send a customer message.
 */
export { PROVIDER_PRESETS };

export function fail(res: Response, error: unknown): void {
  if (error instanceof ProviderValidationError) {
    res.status(error.message === 'not_found' ? 404 : 400).json({ error: error.message, fields: error.fields });
    return;
  }
  if (error instanceof SimpleProviderError) {
    res.status(400).json({ error: error.message, fields: error.fields });
    return;
  }
  if (error instanceof RoutingOrderError) {
    res.status(400).json({ error: error.message, fields: error.keys });
    return;
  }
  logger.error({ errorName: (error as Error)?.name, errorMessage: String((error as Error)?.message ?? error).slice(0, 200) }, 'AI routing request failed');
  res.status(500).json({ error: 'internal_server_error' });
}

export function idParam(req: Request): number {
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) throw new ProviderValidationError('not_found', []);
  return id;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** The full (detailed) provider payload. */
export function inputFrom(body: unknown): AiProviderInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : typeof v === 'string' ? v === 'true' || v === '1' || v === 'on' : dflt);
  const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v));
  return {
    name: str(b.name), kind: (PROVIDER_KINDS as readonly string[]).includes(str(b.kind)) ? (str(b.kind) as ProviderKind) : ('' as ProviderKind), baseUrl: str(b.baseUrl),
    apiKey: typeof b.apiKey === 'string' ? b.apiKey.trim() : undefined,
    models: csv(str(b.models)), visionModels: csv(str(b.visionModels)), audioModels: csv(str(b.audioModels)),
    freeTier: bool(b.freeTier, true), supportsTools: bool(b.supportsTools, true), enabled: bool(b.enabled, true), priority: num(b.priority), timeoutMs: num(b.timeoutMs), notes: str(b.notes) || null,
  };
}

/** True for the two-field form ({ name, config }); anything else is the detailed payload. */
export const isSimpleBody = (body: unknown): boolean => typeof (body as { config?: unknown } | null)?.config === 'string';

/** A new provider from the two-field form: the preset decides endpoint, kind and example models. */
export function createInputFromSimple(body: unknown): AiProviderInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const num = Number(b.timeoutMs);
  return resolveSimpleProvider({ name: str(b.name), config: str(b.config), provider: str(b.provider), models: str(b.models), baseUrl: str(b.baseUrl), timeoutMs: Number.isFinite(num) && num > 0 ? num : undefined });
}

/** An edit from the two-field form: only the name and the configuration change; models, capabilities and the rest stay as they were. */
export function updateInputFromSimple(existing: AiProviderRow, body: unknown): AiProviderInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const config = str(b.config);
  const models = str(b.models) ? csv(str(b.models)) : csv(existing.models);
  return {
    name: str(b.name) || existing.name, kind: existing.kind, baseUrl: str(b.baseUrl) || existing.base_url,
    apiKey: config ? (/^none$/i.test(config) ? '' : config) : undefined,
    models, visionModels: csv(existing.vision_models), audioModels: csv(existing.audio_models), freeTier: existing.free_tier !== 0, supportsTools: existing.supports_tools !== 0,
    enabled: typeof b.enabled === 'boolean' ? b.enabled : existing.enabled !== 0, timeoutMs: existing.timeout_ms, notes: existing.notes,
  };
}

export function mayManageShared(req: Request): boolean {
  return isSuperAdmin((req.authUser as AuthUser | undefined) ?? null);
}

/** One tiny completion on the provider's first chat model: proves the key, the endpoint and the model. Never sends a customer message. */
export async function runProviderTest(row: AiProviderRow): Promise<{ ok: boolean; detail: string; latencyMs: number; category?: string }> {
  const model = csv(row.models)[0] ?? csv(row.vision_models)[0];
  if (!model) return { ok: false, detail: 'No model is configured for this provider.', latencyMs: 0 };
  const apiKey = providerApiKey(row);
  if (!apiKey) { recordProviderTest(row.id, false, 'no usable API key saved'); return { ok: false, detail: 'No usable API key is saved for this provider.', latencyMs: 0 }; }
  const candidate: RouteCandidate = { key: `${row.id}:${model}`, providerKey: `provider:${row.id}`, providerId: row.id, providerName: row.name, kind: row.kind, baseUrl: row.base_url, apiKey, model, free: row.free_tier !== 0, image: null, audio: null, tools: row.supports_tools !== 0, timeoutMs: Math.min(row.timeout_ms, 30_000), builtin: false };
  const started = Date.now();
  try {
    await routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 8, temperature: 0, deadline: Date.now() + 30_000, candidatesOverride: [candidate] });
    const detail = `Model ${model} answered in ${((Date.now() - started) / 1000).toFixed(1)} s.`;
    recordProviderTest(row.id, true, detail);
    return { ok: true, detail, latencyMs: Date.now() - started };
  } catch (error) {
    const detail = describeFailure(error);
    const category = error instanceof AiResponseError && error.attempts[0] ? error.attempts[0].reason : error instanceof AiCredentialError ? 'credential' : 'unknown';
    recordProviderTest(row.id, false, detail);
    return { ok: false, detail, category, latencyMs: Date.now() - started };
  }
}

/** A short, secret-free sentence for a failed call (the provider's own words are limited to its short reason). */
export function describeFailure(error: unknown): string {
  if (error instanceof AiCredentialError) return `The provider rejected the API key (HTTP ${error.httpStatus ?? '?'}).`;
  if (error instanceof AiResponseError) return `${error.describe()}`;
  return 'The provider could not be reached.';
}

async function builtinSummary(accountId: number): Promise<Record<string, unknown>> {
  const settings = getBusinessSettings(accountId);
  const key = getEffectiveCredential('OPENROUTER_API_KEY');
  const diag = describeCredential('OPENROUTER_API_KEY');
  const models = [settings.openRouterModel, ...settings.openRouterFallbackModels].filter((m, i, a) => m && a.indexOf(m) === i);
  const priced = await Promise.all(models.map(async (m) => { const info = await getModelInfo(m); return { model: m, free: info ? info.free : null, image: info ? info.image : null, tools: info ? info.tools : null }; }));
  return {
    openRouter: { hasKey: isUsableApiKey(key), source: diag.source, overrideStatus: diag.overrideStatus, chatModel: settings.openRouterModel, visionModel: settings.openRouterVisionModel, audioModel: settings.openRouterAudioModel, fallbackModels: settings.openRouterFallbackModels, models: priced, priority: BUILTIN_OPENROUTER_PRIORITY },
    budget: { routingBudgetMs: env.AI_ROUTING_BUDGET_MS, maxRoutesPerMessage: env.AI_ROUTE_MAX_ATTEMPTS },
  };
}

/** What a business is told about its Default entry: how many shared providers can answer — never a name, an address or a key. */
export function defaultPoolSummary(): { total: number; usable: number; disabled: number; builtinOpenRouter: boolean } {
  const shared = listSharedProviders();
  const usable = shared.filter((r) => r.enabled !== 0 && providerApiKey(r) !== null).length;
  return {
    total: shared.length, usable, disabled: shared.filter((r) => r.enabled === 0).length,
    // the built-in OpenRouter key counts as a Default member only while no shared OpenRouter provider has taken its place
    builtinOpenRouter: isUsableApiKey(getEffectiveCredential('OPENROUTER_API_KEY')) && !listSharedProviders().some((r) => r.kind === 'openrouter' && csv(r.models).length > 0),
  };
}

type EntryState = 'ok' | 'failed' | 'untested' | 'off' | 'no_key' | 'empty';

/** The ordered entries of a business with a compact status each: Default first by default, then its own providers. */
export function buildEntries(accountId: number): Array<Record<string, unknown>> {
  const own = new Map(listProvidersForAccount(accountId).filter((r) => r.whatsapp_account_id === accountId).map((r) => [r.id, r]));
  const pool = defaultPoolSummary();
  return getAccountRouting(accountId).map((entry) => {
    if (entry.type === 'default') {
      const members = pool.usable + (pool.builtinOpenRouter ? 1 : 0);
      const state: EntryState = !entry.enabled ? 'off' : members > 0 ? 'ok' : 'empty';
      const detail = !entry.enabled ? 'Switched off for this business.'
        : members > 0 ? `${pool.usable + (pool.builtinOpenRouter ? 1 : 0)} shared provider${members === 1 ? '' : 's'} available${pool.disabled ? ` (${pool.disabled} turned off by the administrator)` : ''}.`
          : pool.total > 0 ? 'The shared providers are turned off or have no usable key. Ask the Super Admin.' : 'No shared provider is configured yet. The Super Admin adds them under Super Admin Settings.';
      return { key: entry.key, type: 'default', id: null, name: 'Default', position: entry.position, enabled: entry.enabled, state, detail };
    }
    const row = own.get(entry.providerId as number);
    const view = row ? toView(row) : null;
    const state: EntryState = !view ? 'empty' : !view.enabled ? 'off' : view.keyStatus !== 'ok' ? 'no_key' : view.lastTestAt ? (view.lastTestOk ? 'ok' : 'failed') : 'untested';
    const detail = !view ? '' : state === 'no_key' ? (view.keyStatus === 'undecryptable' ? 'The saved key cannot be read: enter it again.' : 'No API key saved.') : view.lastTestDetail ?? '';
    return { key: entry.key, type: 'provider', id: entry.providerId, name: view?.name ?? '', provider: view?.kind, config: view ? view.keyMasked : null, models: view?.models ?? [], position: entry.position, enabled: Boolean(view?.enabled), state, detail, lastTestAt: view?.lastTestAt ?? null };
  });
}

export function registerAiRoutingRoutes(router: Router): void {
  router.get('/api/dashboard/ai-routing', async (req, res) => {
    try {
      const accountId = currentAccountId();
      const settings = getBusinessSettings(accountId);
      const [chat, vision, audio, builtin] = await Promise.all([explainRoutes(accountId, 'chat'), explainRoutes(accountId, 'vision'), explainRoutes(accountId, 'audio'), builtinSummary(accountId)]);
      res.json({
        settings: { freeOnly: settings.aiFreeOnly, failover: settings.aiFailoverEnabled },
        // the ordered list the router really follows (Default + this business's own providers) and the compact summary of the Default pool
        entries: buildEntries(accountId),
        defaultPool: defaultPoolSummary(),
        // this business's own providers only: shared providers (their names, addresses and masked keys) belong to the Super Admin's page
        providers: listProvidersForAccount(accountId).filter((r) => r.whatsapp_account_id === accountId).map(toView),
        presets: PROVIDER_PRESETS.map((p) => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, hint: p.hint, models: p.models })),
        canManageShared: mayManageShared(req),
        builtin,
        plan: { chat, vision, audio },
        cooldowns: activeCooldowns().map((c) => ({ ...c, untilIso: new Date(c.until).toISOString() })),
        // Messages waiting for an AI answer / recovered / left for staff, the five-minute escalations, and the voice-call capability (never any customer text).
        recovery: {
          messages: pendingReplyCounts(accountId),
          escalations: listEscalations(accountId, 10).map((e) => ({ id: e.id, kind: e.ref_kind, status: e.status, reason: e.reason, voiceCall: e.voice_call_status, voiceCallDetail: e.voice_call_detail, at: e.created_at, resolvedAt: e.resolved_at })),
          voiceCall: voiceCallCapability(),
        },
        history: listRouteLog(accountId, 60),
        stats: routeStats(accountId, 24),
        statsWeek: routeStats(accountId, 24 * 7),
      });
    } catch (error) {
      fail(res, error);
    }
  });

  router.put('/api/dashboard/ai-routing/settings', (req, res) => {
    try {
      const b = (req.body ?? {}) as { freeOnly?: unknown; failover?: unknown };
      const patch: { aiFreeOnly?: boolean; aiFailoverEnabled?: boolean } = {};
      if (typeof b.freeOnly === 'boolean') patch.aiFreeOnly = b.freeOnly;
      if (typeof b.failover === 'boolean') patch.aiFailoverEnabled = b.failover;
      if (!Object.keys(patch).length) { res.status(400).json({ error: 'validation_failed', fields: ['freeOnly', 'failover'] }); return; }
      updateBusinessSettings(patch);
      const settings = getBusinessSettings();
      logger.info({ account: currentAccountId(), adminUserId: req.adminUserId, freeOnly: settings.aiFreeOnly, failover: settings.aiFailoverEnabled }, 'AI routing switches changed');
      res.json({ ok: true, settings: { freeOnly: settings.aiFreeOnly, failover: settings.aiFailoverEnabled } });
    } catch (error) {
      fail(res, error);
    }
  });

  /** Saves this business's routing order (and the on/off switch of the Default entry). The router follows it on the very next message. */
  router.put('/api/dashboard/ai-routing/order', (req, res) => {
    try {
      const list = (req.body as { entries?: unknown } | null)?.entries;
      if (!Array.isArray(list) || list.length === 0) { res.status(400).json({ error: 'validation_failed', fields: ['entries'] }); return; }
      const entries = list.map((e) => ({ key: str((e as { key?: unknown })?.key), enabled: typeof (e as { enabled?: unknown })?.enabled === 'boolean' ? ((e as { enabled: boolean }).enabled) : undefined }));
      saveAccountRouting(currentAccountId(), entries, (req.adminUserId as number | undefined) ?? null);
      logger.info({ account: currentAccountId(), adminUserId: req.adminUserId, order: entries.map((e) => e.key) }, 'AI routing order saved');
      res.json({ ok: true, entries: buildEntries(currentAccountId()) });
    } catch (error) {
      fail(res, error);
    }
  });

  /** A tiny completion through the Default entry only (the shared pool, in the pool's order, honouring cooldowns and strict free-only mode). */
  router.post('/api/dashboard/ai-routing/entries/default/test', async (_req, res) => {
    try {
      const accountId = currentAccountId();
      const sharedIds = new Set(listSharedProviders().map((r) => r.id));
      const plan = await buildCandidates(accountId, 'chat', { wantsTools: false });
      const candidates = plan.eligible.filter((c) => c.builtin || (c.providerId !== null && sharedIds.has(c.providerId)));
      if (candidates.length === 0) { res.json({ ok: false, detail: 'No shared provider is usable right now (none configured, turned off, cooling down, or not free).' }); return; }
      const started = Date.now();
      try {
        await routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 8, temperature: 0, deadline: Date.now() + 30_000, candidatesOverride: candidates.slice(0, 2) });
        res.json({ ok: true, detail: `Answered in ${((Date.now() - started) / 1000).toFixed(1)} s.`, latencyMs: Date.now() - started });
      } catch (error) {
        res.json({ ok: false, detail: describeFailure(error), latencyMs: Date.now() - started });
      }
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/api/dashboard/ai-routing/providers', (req, res) => {
    try {
      const shared = Boolean((req.body as { shared?: unknown })?.shared);
      if (shared && !mayManageShared(req)) { res.status(403).json({ error: 'Only a super administrator can add a provider shared by every business' }); return; }
      const input = isSimpleBody(req.body) ? createInputFromSimple(req.body) : inputFrom(req.body);
      const row = createProvider(input, { accountId: shared ? null : currentAccountId(), updatedBy: req.adminUserId as number });
      logger.info({ providerId: row.id, provider: row.name, kind: row.kind, shared, account: currentAccountId(), adminUserId: req.adminUserId }, 'AI provider created');
      res.status(201).json({ provider: toView(row), entries: shared ? undefined : buildEntries(currentAccountId()) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.put('/api/dashboard/ai-routing/providers/:id', (req, res) => {
    try {
      const id = idParam(req);
      const existing = getProvider(id, currentAccountId());
      if (!existing) { res.status(404).json({ error: 'not_found' }); return; }
      if (existing.whatsapp_account_id === null && !mayManageShared(req)) { res.status(403).json({ error: 'Only a super administrator can change a provider shared by every business' }); return; }
      const input = isSimpleBody(req.body) ? updateInputFromSimple(existing, req.body) : inputFrom(req.body);
      const row = updateProvider(id, currentAccountId(), input, req.adminUserId as number);
      logger.info({ providerId: row.id, provider: row.name, adminUserId: req.adminUserId, keyChanged: input.apiKey !== undefined }, 'AI provider updated');
      res.json({ provider: toView(row) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/api/dashboard/ai-routing/providers/:id/:action(enable|disable)', (req, res) => {
    try {
      const id = idParam(req);
      const existing = getProvider(id, currentAccountId());
      if (!existing) { res.status(404).json({ error: 'not_found' }); return; }
      if (existing.whatsapp_account_id === null && !mayManageShared(req)) { res.status(403).json({ error: 'Only a super administrator can change a provider shared by every business' }); return; }
      const row = setProviderEnabled(id, currentAccountId(), req.params.action === 'enable', req.adminUserId as number);
      res.json({ provider: row ? toView(row) : null });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/api/dashboard/ai-routing/providers/:id', (req, res) => {
    try {
      const id = idParam(req);
      const existing = getProvider(id, currentAccountId());
      if (!existing) { res.status(404).json({ error: 'not_found' }); return; }
      if (existing.whatsapp_account_id === null && !mayManageShared(req)) { res.status(403).json({ error: 'Only a super administrator can remove a provider shared by every business' }); return; }
      deleteProvider(id, currentAccountId());
      logger.info({ providerId: id, provider: existing.name, adminUserId: req.adminUserId }, 'AI provider removed');
      res.json({ ok: true, entries: existing.whatsapp_account_id === null ? undefined : buildEntries(currentAccountId()) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/api/dashboard/ai-routing/providers/:id/test', async (req, res) => {
    try {
      const id = idParam(req);
      const row = getProvider(id, currentAccountId());
      if (!row) { res.status(404).json({ error: 'not_found' }); return; }
      // a business can test its own providers; the shared ones are tested through the Default entry (their keys are not its business)
      if (row.whatsapp_account_id === null && !mayManageShared(req)) { res.status(403).json({ error: 'Only a super administrator can test a provider shared by every business' }); return; }
      const result = await runProviderTest(row);
      res.json({ ...result, provider: toView(getProvider(id, currentAccountId())!) });
    } catch (error) {
      fail(res, error);
    }
  });
}
