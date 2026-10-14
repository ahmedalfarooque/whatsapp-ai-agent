import type { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { currentAccountId } from '../accounts/accountContext';
import { env } from '../config/env';
import { getBusinessSettings, updateBusinessSettings } from '../config/businessSettings';
import { describeCredential, getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { isSuperAdmin, type AuthUser } from './permissions';
import { activeCooldowns, explainRoutes, routeCompletion, type RouteCandidate } from '../llm/aiRouter';
import { AiCredentialError } from '../llm/aiCredentialError';
import { AiResponseError } from '../llm/aiResponseError';
import { getModelInfo } from '../llm/modelCatalog';
import { createProvider, csv, deleteProvider, getProvider, listProvidersForAccount, PROVIDER_KINDS, providerApiKey, ProviderValidationError, recordProviderTest, setProviderEnabled, toView, updateProvider, type AiProviderInput, type ProviderKind } from '../llm/providerRepo';
import { listRouteLog, routeStats } from '../llm/routeLog';
import { pendingReplyCounts } from '../replay/pendingReplyRepo';
import { listEscalations } from '../escalation/escalationService';
import { voiceCallCapability } from '../escalation/voiceCall';

/**
 * AI routing administration for the SELECTED account (authorize.ts: the "configuration" capability). Providers shared by every business
 * can be created, changed or removed by a super administrator only; an account-specific provider by anyone who may configure that
 * account. A key is written once and never read back: the API returns `hasKey` and a masked preview. Test calls use one tiny
 * completion (max 8 tokens) and are recorded on the provider and in the route log; nothing here sends a customer message.
 */

/** Presets the dashboard offers (base URLs of the OpenAI-compatible endpoints; the administrator supplies the key and the free models). */
export const PROVIDER_PRESETS: Array<{ id: string; name: string; kind: ProviderKind; baseUrl: string; hint: string; models: string }> = [
  { id: 'openrouter', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', hint: 'Free models end in :free and need the account privacy setting to allow non-ZDR endpoints.', models: '' },
  { id: 'groq', name: 'Groq', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', hint: 'Free developer tier (daily request limits, no card).', models: 'llama-3.3-70b-versatile,llama-3.1-8b-instant' },
  { id: 'google', name: 'Google AI Studio (Gemini)', kind: 'openai_compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', hint: 'Free tier of the Gemini API (daily limits, no card).', models: 'gemini-2.5-flash-lite,gemini-2.5-flash' },
  { id: 'cerebras', name: 'Cerebras', kind: 'openai_compatible', baseUrl: 'https://api.cerebras.ai/v1', hint: 'Free tier (daily token limits).', models: 'llama-3.3-70b,llama3.1-8b' },
  { id: 'mistral', name: 'Mistral', kind: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1', hint: 'Free experiment tier (rate limited; data may be used for training).', models: 'mistral-small-latest' },
  { id: 'ollama', name: 'Local Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', hint: 'A model running on this server (no key, no cost, slow on a CPU; never a public address).', models: 'qwen2.5:1.5b-instruct-q4_K_M' },
  { id: 'custom', name: 'Custom OpenAI-compatible', kind: 'openai_compatible', baseUrl: '', hint: 'Any /v1/chat/completions endpoint.', models: '' },
];

function fail(res: Response, error: unknown): void {
  if (error instanceof ProviderValidationError) {
    res.status(error.message === 'not_found' ? 404 : 400).json({ error: error.message, fields: error.fields });
    return;
  }
  logger.error({ errorName: (error as Error)?.name, errorMessage: String((error as Error)?.message ?? error).slice(0, 200) }, 'AI routing request failed');
  res.status(500).json({ error: 'internal_server_error' });
}

function idParam(req: Request): number {
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) throw new ProviderValidationError('not_found', []);
  return id;
}

function inputFrom(body: unknown): AiProviderInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : typeof v === 'string' ? v === 'true' || v === '1' || v === 'on' : dflt);
  const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v));
  return {
    name: str(b.name), kind: (PROVIDER_KINDS as readonly string[]).includes(str(b.kind)) ? (str(b.kind) as ProviderKind) : ('' as ProviderKind), baseUrl: str(b.baseUrl),
    apiKey: typeof b.apiKey === 'string' ? b.apiKey.trim() : undefined,
    models: csv(str(b.models)), visionModels: csv(str(b.visionModels)), audioModels: csv(str(b.audioModels)),
    freeTier: bool(b.freeTier, true), supportsTools: bool(b.supportsTools, true), enabled: bool(b.enabled, true), priority: num(b.priority), timeoutMs: num(b.timeoutMs), notes: str(b.notes) || null,
  };
}

function mayManageShared(req: Request): boolean {
  return isSuperAdmin((req.authUser as AuthUser | undefined) ?? null);
}

async function builtinSummary(accountId: number): Promise<Record<string, unknown>> {
  const settings = getBusinessSettings(accountId);
  const key = getEffectiveCredential('OPENROUTER_API_KEY');
  const diag = describeCredential('OPENROUTER_API_KEY');
  const models = [settings.openRouterModel, ...settings.openRouterFallbackModels].filter((m, i, a) => m && a.indexOf(m) === i);
  const priced = await Promise.all(models.map(async (m) => { const info = await getModelInfo(m); return { model: m, free: info ? info.free : null, image: info ? info.image : null, tools: info ? info.tools : null }; }));
  return {
    openRouter: { hasKey: isUsableApiKey(key), source: diag.source, overrideStatus: diag.overrideStatus, chatModel: settings.openRouterModel, visionModel: settings.openRouterVisionModel, audioModel: settings.openRouterAudioModel, fallbackModels: settings.openRouterFallbackModels, models: priced, priority: 50 },
    local: { configured: Boolean(env.OLLAMA_BASE_URL && csv(env.OLLAMA_MODELS).length), baseUrl: env.OLLAMA_BASE_URL ? env.OLLAMA_BASE_URL.replace(/\/\/[^/]+@/, '//') : '', models: csv(env.OLLAMA_MODELS), visionModels: csv(env.OLLAMA_VISION_MODELS), timeoutMs: env.OLLAMA_TIMEOUT_MS, priority: 900 },
    budget: { routingBudgetMs: env.AI_ROUTING_BUDGET_MS, maxRoutesPerMessage: env.AI_ROUTE_MAX_ATTEMPTS },
  };
}

export function registerAiRoutingRoutes(router: Router): void {
  router.get('/api/dashboard/ai-routing', async (req, res) => {
    try {
      const accountId = currentAccountId();
      const settings = getBusinessSettings(accountId);
      const [chat, vision, audio, builtin] = await Promise.all([explainRoutes(accountId, 'chat'), explainRoutes(accountId, 'vision'), explainRoutes(accountId, 'audio'), builtinSummary(accountId)]);
      res.json({
        settings: { freeOnly: settings.aiFreeOnly, failover: settings.aiFailoverEnabled },
        providers: listProvidersForAccount(accountId).map(toView),
        presets: PROVIDER_PRESETS,
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

  router.post('/api/dashboard/ai-routing/providers', (req, res) => {
    try {
      const shared = Boolean((req.body as { shared?: unknown })?.shared);
      if (shared && !mayManageShared(req)) { res.status(403).json({ error: 'Only a super administrator can add a provider shared by every business' }); return; }
      const row = createProvider(inputFrom(req.body), { accountId: shared ? null : currentAccountId(), updatedBy: req.adminUserId as number });
      logger.info({ providerId: row.id, provider: row.name, kind: row.kind, shared, account: currentAccountId(), adminUserId: req.adminUserId }, 'AI provider created');
      res.status(201).json({ provider: toView(row) });
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
      const row = updateProvider(id, currentAccountId(), inputFrom(req.body), req.adminUserId as number);
      logger.info({ providerId: row.id, provider: row.name, adminUserId: req.adminUserId, keyChanged: typeof (req.body as { apiKey?: unknown })?.apiKey === 'string' }, 'AI provider updated');
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
      res.json({ ok: true });
    } catch (error) {
      fail(res, error);
    }
  });

  /** One tiny completion on the provider's first chat model (or vision / audio model when asked): proves the key, the endpoint and the model. */
  router.post('/api/dashboard/ai-routing/providers/:id/test', async (req, res) => {
    try {
      const id = idParam(req);
      const row = getProvider(id, currentAccountId());
      if (!row) { res.status(404).json({ error: 'not_found' }); return; }
      const task = (req.body as { task?: unknown })?.task === 'vision' ? 'vision' : 'chat';
      const model = csv(task === 'vision' ? row.vision_models : row.models)[0] ?? csv(row.models)[0];
      if (!model) { res.status(400).json({ error: 'validation_failed', fields: ['models'] }); return; }
      const apiKey = row.kind === 'ollama' ? null : providerApiKey(row);
      if (row.kind !== 'ollama' && !apiKey) { recordProviderTest(id, false, 'no usable API key saved'); res.json({ ok: false, detail: 'No usable API key is saved for this provider.', provider: toView(getProvider(id, currentAccountId())!) }); return; }
      const candidate: RouteCandidate = { key: `${row.id}:${model}`, providerKey: `provider:${row.id}`, providerId: row.id, providerName: row.name, kind: row.kind, baseUrl: row.base_url, apiKey, model, free: row.free_tier !== 0, image: null, audio: null, tools: row.supports_tools !== 0, timeoutMs: Math.min(row.timeout_ms, 30_000), local: row.kind === 'ollama', builtin: false };
      const started = Date.now();
      try {
        const response = await routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'Reply with the single word: ok' }], maxTokens: 8, temperature: 0, deadline: Date.now() + 30_000, candidatesOverride: [candidate] });
        const detail = `Model ${model} answered in ${((Date.now() - started) / 1000).toFixed(1)} s${response.servedBy?.source === 'local' ? ' (local)' : ''}.`;
        recordProviderTest(id, true, detail);
        res.json({ ok: true, detail, latencyMs: Date.now() - started, provider: toView(getProvider(id, currentAccountId())!) });
      } catch (error) {
        const detail = error instanceof AiCredentialError
          ? `The provider rejected the API key (HTTP ${error.httpStatus ?? '?'}).`
          : error instanceof AiResponseError
            ? `${error.describe()}`
            : 'The provider could not be reached.';
        const category = error instanceof AiResponseError && error.attempts[0] ? error.attempts[0].reason : error instanceof AiCredentialError ? 'credential' : 'unknown';
        recordProviderTest(id, false, detail);
        res.json({ ok: false, detail, category, latencyMs: Date.now() - started, provider: toView(getProvider(id, currentAccountId())!) });
      }
    } catch (error) {
      fail(res, error);
    }
  });
}
