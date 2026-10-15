import { env } from '../config/env';
import { getBusinessSettings } from '../config/businessSettings';
import { getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { currentAccountId } from '../accounts/accountContext';
import { logger } from '../logger';
import { AiCredentialError } from './aiCredentialError';
import { AiResponseError, type AiResponseReason, type ModelAttemptRecord } from './aiResponseError';
import { completeOnce, openRouterHeaders } from './openAiCompatible';
import { getModelInfo } from './modelCatalog';
import { csv, listProvidersForAccount, providerApiKey, type AiProviderRow, type ProviderKind } from './providerRepo';
import { recordRouteAttempt } from './routeLog';
import { DEFAULT_ENTRY, getAccountRouting, providerEntryKey } from './routingOrder';
import type { ChatCompletionResponse, ChatMessage } from './types';
import type { ToolDefinition } from '../tools';

/**
 * The central AI routing layer: every AI task (chat, picture analysis, voice transcription) goes through here.
 *
 *  Order of routes: the business's providers by priority (shared ones and its own; see providerRepo) — the built-in OpenRouter key
 *  (dashboard / .env) sits at priority 50 so an administrator can put a free provider before or after it — then the built-in local
 *  Ollama route (env OLLAMA_BASE_URL, priority 900), and finally the pipeline's deterministic customer-service fallback (not here).
 *
 *  A route is skipped, with the reason recorded, when: the provider is disabled or has no usable key; it is cooling down after a recent
 *  failure; strict free-only mode is on and the route may cost money (an OpenRouter model whose catalog price is not 0, a provider the
 *  administrator did not declare as a free tier — fail-closed: unknown = not free); it lacks a capability the task needs (image / audio
 *  must be KNOWN, tool calling when tools are offered). Eligible routes are tried ONE after another, each with its own hard timeout,
 *  within one routing budget; a failure is classified (auth, credit, rate limit, data policy, capability, model unavailable, timeout,
 *  network, provider error, empty) and puts the route — or, for an account-wide problem, the whole provider — into a cooldown so a
 *  dead route is not tried on every message. There is NO retry against the same route except one bounded retry when it is the only
 *  eligible route. The same messages (tool results included) go to every route, so no tool ever runs twice and the language, business
 *  context and account isolation are preserved. Every attempt is logged (ai_route_log) without the prompt, the key or customer text.
 */
export type AiTask = 'chat' | 'vision' | 'audio';
export type FailureCategory = 'context' | 'auth' | 'credit' | 'rate_limited' | 'policy' | 'capability' | 'model_unavailable' | 'timeout' | 'network' | 'provider_error' | 'empty' | 'malformed';
export type SkipCategory = 'disabled' | 'no_key' | 'cooldown' | 'free_only' | 'capability' | 'no_time' | 'limit';

export interface RouteCandidate {
  key: string;
  providerKey: string;
  providerId: number | null;
  providerName: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  free: boolean | null;
  image: boolean | null;
  audio: boolean | null;
  tools: boolean | null;
  timeoutMs: number;
  local: boolean;
  builtin: boolean;
}

export interface SkippedRoute { candidate: RouteCandidate; category: SkipCategory; reason: string }

export interface RouteRequest {
  task: AiTask;
  messages: ChatMessage[];
  /** A shorter rendering of the same conversation for a slow local model (same facts, less text). */
  compactMessages?: ChatMessage[];
  tools?: ToolDefinition['schema'][];
  temperature?: number;
  maxTokens?: number;
  /** Epoch ms after which no new attempt may start. */
  deadline?: number;
  needs?: { image?: boolean; audio?: boolean };
  /** Pins the route list to these candidates (tests / provider tests). */
  candidatesOverride?: RouteCandidate[];
}

export interface RouteAttempt { candidate: RouteCandidate; outcome: 'ok' | 'failed'; category: FailureCategory | null; httpStatus: number | null; latencyMs: number; detail: string | null }

export interface RoutedResponse extends ChatCompletionResponse {
  route: { candidate: RouteCandidate; attempts: RouteAttempt[]; skipped: SkippedRoute[]; source: 'cloud' | 'local'; totalMs: number };
}

// Inside the Default entry the shared providers (priority 1-499, set by the Super Admin's order) come first, then the server's built-in OpenRouter key, then the built-in local route.
export const BUILTIN_OPENROUTER_PRIORITY = 500;
export const BUILTIN_LOCAL_PRIORITY = 900;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MIN_ATTEMPT_MS = 1500;

// Test hook only: the test suite stubs the network, so OpenRouter's catalog is never read and every model's price is unknown; strict
// free-only mode would (correctly) skip them all. Tests that exercise the client opt in to "unknown price = allowed"; tests of the
// fail-closed rule switch it off again. Production never sets this.
let unknownPriceAllowedInTests = false;
export function allowUnknownPriceForTests(flag: boolean): void { unknownPriceAllowedInTests = flag; }

// ---- cooldowns (in memory; a restart clears them, which is fine: the next failure sets them again) ---------------------------------
const routeCooling = new Map<string, { until: number; why: string }>();
const providerCooling = new Map<string, { until: number; why: string }>();

export function coolingUntil(key: string, now = Date.now()): { until: number; why: string } | null {
  const entry = routeCooling.get(key) ?? providerCooling.get(key);
  if (!entry) return null;
  if (entry.until <= now) { routeCooling.delete(key); providerCooling.delete(key); return null; }
  return entry;
}

function cooldownFor(category: FailureCategory, error: AiResponseError | null, local: boolean): { ms: number; scope: 'route' | 'provider' } {
  switch (category) {
    // A prompt that is too long for THIS model says nothing about the route: a shorter prompt (or the compact local one) may fit.
    case 'context': return { ms: 0, scope: 'route' };
    case 'auth': return { ms: 10 * 60_000, scope: 'provider' };
    case 'credit': return { ms: 30 * 60_000, scope: 'provider' };
    case 'policy': return { ms: 30 * 60_000, scope: 'route' };
    case 'capability': return { ms: 60 * 60_000, scope: 'route' };
    case 'rate_limited': return { ms: error?.retryAfterMs ?? 60_000, scope: 'route' };
    case 'model_unavailable': return { ms: 5 * 60_000, scope: 'route' };
    case 'timeout': return { ms: local ? 3 * 60_000 : 60_000, scope: 'route' };
    case 'network': return { ms: local ? 2 * 60_000 : 60_000, scope: 'provider' };
    case 'provider_error': return { ms: 60_000, scope: 'route' };
    // One empty or malformed answer says nothing about the next one: no cooldown (the failure is still logged and counted).
    case 'empty':
    case 'malformed': return { ms: 0, scope: 'route' };
  }
}

/** The failure category of one route attempt — provider-specific wording is recognised, never guessed from the status alone when the message says more. */
export function classifyRouteFailure(error: unknown): FailureCategory {
  if (error instanceof AiCredentialError) return 'auth';
  if (!(error instanceof AiResponseError)) return 'provider_error';
  const message = (error.providerMessage ?? '').toLowerCase();
  if (error.network) return message === 'timeout' ? 'timeout' : 'network';
  if (error.reason === 'payment_required') return 'credit';
  if (error.reason === 'rate_limited') return 'rate_limited';
  if (error.reason === 'empty_response') return 'empty';
  if (error.reason === 'malformed_response') return 'malformed';
  if (error.reason === 'model_unavailable') {
    if (/context length|context window|maximum context|too many tokens|token limit|reduce the length|input is too long|exceeds the limit of/.test(message) && !/prompt tokens limit exceeded: \d+ > \d+/.test(message)) return 'context';
    if (/data policy|zdr|privacy|guardrail|moderation|not allowed|blocked by/.test(message)) return 'policy';
    if (/image|audio|modalit|does not support|unsupported|tool|function/.test(message)) return 'capability';
    if (/credit|quota|billing|insufficient|exceeded your current/.test(message)) return 'credit';
    if (/rate limit|too many requests/.test(message)) return 'rate_limited';
    return 'model_unavailable';
  }
  return 'provider_error';
}

const reasonOf = (category: FailureCategory): AiResponseReason =>
  category === 'credit' ? 'payment_required' : category === 'rate_limited' ? 'rate_limited' : category === 'empty' ? 'empty_response' : category === 'malformed' ? 'malformed_response'
    : category === 'policy' || category === 'capability' || category === 'model_unavailable' || category === 'context' ? 'model_unavailable' : 'provider_error';

// ---- candidates ------------------------------------------------------------------------------------------------------------------------
function modelsFor(row: AiProviderRow, task: AiTask): string[] {
  return csv(task === 'chat' ? row.models : task === 'vision' ? row.vision_models : row.audio_models);
}

async function describeModel(kind: ProviderKind, model: string, row: AiProviderRow | null, task: AiTask): Promise<Pick<RouteCandidate, 'free' | 'image' | 'audio' | 'tools'>> {
  if (kind === 'openrouter') {
    const info = await getModelInfo(model);
    return { free: info ? info.free : null, image: info ? info.image : null, audio: info ? info.audio : null, tools: info ? info.tools : null };
  }
  // A provider the administrator configured: its declarations are the facts (a model listed for pictures takes pictures; free tier as declared).
  return { free: row ? row.free_tier !== 0 : true, image: task === 'vision' ? true : null, audio: task === 'audio' ? true : null, tools: row ? row.supports_tools !== 0 : true };
}

export async function buildCandidates(accountId: number, task: AiTask, opts: { needs?: RouteRequest['needs']; wantsTools: boolean; now?: number } = { wantsTools: false }): Promise<{ eligible: RouteCandidate[]; skipped: SkippedRoute[]; freeOnly: boolean; failover: boolean }> {
  const now = opts.now ?? Date.now();
  const settings = getBusinessSettings(accountId);
  const freeOnly = settings.aiFreeOnly;
  const all: Array<{ priority: number; order: number; candidate: RouteCandidate; disabled?: string; entryKey: string }> = [];
  let order = 0;

  // 1. configured providers: the shared pool (= the "Default" entry of every business) and this business's own providers (one entry each)
  for (const row of listProvidersForAccount(accountId)) {
    const entryKey = row.whatsapp_account_id === null ? DEFAULT_ENTRY : providerEntryKey(row.id);
    const models = modelsFor(row, task);
    if (models.length === 0) continue;
    const apiKey = row.kind === 'ollama' ? null : providerApiKey(row);
    const disabled = row.enabled === 0 ? 'provider disabled' : row.kind !== 'ollama' && !apiKey ? (row.key_ciphertext ? 'the stored key cannot be read (enter it again)' : 'no API key saved') : undefined;
    for (const model of models) {
      const facts = await describeModel(row.kind, model, row, task);
      all.push({ priority: row.priority, order: order++, disabled, entryKey, candidate: {
        key: `${row.id}:${model}`, providerKey: `provider:${row.id}`, providerId: row.id, providerName: row.name, kind: row.kind, baseUrl: row.base_url, apiKey, model, ...facts,
        timeoutMs: row.timeout_ms, local: row.kind === 'ollama', builtin: false,
      } });
    }
  }

  // 2. the built-in OpenRouter route (the dashboard / .env key with the business's own models)
  const builtinKey = getEffectiveCredential('OPENROUTER_API_KEY');
  const builtinModels = task === 'chat'
    ? [settings.openRouterModel, ...settings.openRouterFallbackModels]
    : task === 'vision'
      ? [settings.openRouterVisionModel, settings.openRouterModel, ...settings.openRouterFallbackModels]
      : settings.openRouterAudioModel ? [settings.openRouterAudioModel] : [];
  const seen = new Set<string>();
  for (const model of builtinModels) {
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const facts = await describeModel('openrouter', model, null, task);
    // The business's own vision / chat model was configured for pictures by the administrator: with the catalog unavailable it is still
    // tried (that is exactly what worked on production); a generic fallback with unknown capability is not.
    const explicit = task === 'vision' && (model === settings.openRouterVisionModel || model === settings.openRouterModel);
    all.push({ priority: BUILTIN_OPENROUTER_PRIORITY, order: order++, entryKey: DEFAULT_ENTRY, disabled: isUsableApiKey(builtinKey) ? undefined : builtinKey.trim() ? 'the saved OpenRouter key is not a usable key (wrong format or length)' : 'no OpenRouter key saved', candidate: {
      key: `builtin:${model}`, providerKey: 'provider:builtin', providerId: null, providerName: 'OpenRouter (built-in key)', kind: 'openrouter', baseUrl: OPENROUTER_BASE_URL, apiKey: isUsableApiKey(builtinKey) ? builtinKey : null, model,
      free: facts.free, image: facts.image ?? (explicit ? true : null), audio: facts.audio, tools: facts.tools, timeoutMs: env.OPENROUTER_TIMEOUT_MS, local: false, builtin: true,
    } });
  }

  // 3. the built-in local route (env OLLAMA_BASE_URL): free by nature, slow on a CPU, last among AI routes
  if (env.OLLAMA_BASE_URL) {
    const localModels = csv(task === 'chat' ? env.OLLAMA_MODELS : task === 'vision' ? env.OLLAMA_VISION_MODELS : '');
    for (const model of localModels) {
      all.push({ priority: BUILTIN_LOCAL_PRIORITY, order: order++, entryKey: DEFAULT_ENTRY, candidate: {
        key: `local:${model}`, providerKey: 'provider:local', providerId: null, providerName: 'Local Ollama (built-in)', kind: 'ollama', baseUrl: env.OLLAMA_BASE_URL, apiKey: null, model,
        free: true, image: task === 'vision' ? true : null, audio: null, tools: true, timeoutMs: env.OLLAMA_TIMEOUT_MS, local: true, builtin: true,
      } });
    }
  }

  // The business's saved order decides which ENTRY is tried first; inside the Default entry the shared pool keeps its own priorities.
  const routing = getAccountRouting(accountId);
  const position = new Map(routing.map((r) => [r.key, r.position]));
  const switchedOff = new Set(routing.filter((r) => !r.enabled).map((r) => r.key));
  all.sort((a, b) => (position.get(a.entryKey) ?? 9999) - (position.get(b.entryKey) ?? 9999) || a.priority - b.priority || a.order - b.order);
  const eligible: RouteCandidate[] = [];
  const skipped: SkippedRoute[] = [];
  for (const entry of all) {
    const c = entry.candidate;
    if (switchedOff.has(entry.entryKey)) { skipped.push({ candidate: c, category: 'disabled', reason: entry.entryKey === DEFAULT_ENTRY ? 'the Default entry is switched off for this business' : 'switched off for this business' }); continue; }
    if (entry.disabled) { skipped.push({ candidate: c, category: entry.disabled.includes('key') ? 'no_key' : 'disabled', reason: entry.disabled }); continue; }
    const cooling = coolingUntil(routeCoolKey(task, c), now) ?? coolingUntil(c.providerKey, now);
    if (cooling) { skipped.push({ candidate: c, category: 'cooldown', reason: `cooling down until ${new Date(cooling.until).toISOString().slice(11, 19)} UTC (${cooling.why})` }); continue; }
    if (freeOnly && c.free !== true && !(c.free === null && unknownPriceAllowedInTests)) { skipped.push({ candidate: c, category: 'free_only', reason: c.free === false ? 'this route costs money (strict free-only mode)' : 'price unknown — treated as paid (strict free-only mode)' }); continue; }
    if (opts.needs?.image && c.image !== true) { skipped.push({ candidate: c, category: 'capability', reason: c.image === false ? 'no image input' : 'image support unknown' }); continue; }
    if (opts.needs?.audio && c.audio !== true) { skipped.push({ candidate: c, category: 'capability', reason: c.audio === false ? 'no audio input' : 'audio support unknown' }); continue; }
    if (opts.wantsTools && c.tools === false) { skipped.push({ candidate: c, category: 'capability', reason: 'no tool calling' }); continue; }
    eligible.push(c);
  }
  return { eligible, skipped, freeOnly, failover: settings.aiFailoverEnabled };
}

// ---- execution -------------------------------------------------------------------------------------------------------------------------
/** Route cooldowns are per task: a model that failed on a picture is not silenced for plain chat (and vice versa). Provider cooldowns are not. */
const routeCoolKey = (task: AiTask, candidate: RouteCandidate): string => `${task}:${candidate.key}`;

function markFailure(task: AiTask, candidate: RouteCandidate, category: FailureCategory, error: AiResponseError | null, now = Date.now()): void {
  const { ms, scope } = cooldownFor(category, error, candidate.local);
  if (ms <= 0) return;
  const entry = { until: now + ms, why: category.replace(/_/g, ' ') };
  if (scope === 'provider') providerCooling.set(candidate.providerKey, entry); else routeCooling.set(routeCoolKey(task, candidate), entry);
}

/** The route as it may be returned or logged: everything except the key. */
function publicCandidate(c: RouteCandidate): RouteCandidate {
  return { ...c, apiKey: null };
}

function attemptRecord(attempt: RouteAttempt, error: unknown): ModelAttemptRecord {
  const model = `${attempt.candidate.providerName} · ${attempt.candidate.model}`;
  if (error instanceof AiCredentialError) return { model, reason: 'credential', httpStatus: error.httpStatus ?? null };
  if (error instanceof AiResponseError) return { model, reason: error.reason, httpStatus: error.httpStatus, providerMessage: error.providerMessage };
  return { model, reason: 'provider_error', httpStatus: null };
}

/**
 * Runs the task on the first route that answers. Throws the FIRST route's error (so the activity names the primary cause) with
 * `attempts` (every route tried) and `fallbackSkipped` (why the others were not) when no route answered.
 */
export async function routeCompletion(request: RouteRequest): Promise<RoutedResponse> {
  const accountId = currentAccountId();
  const started = Date.now();
  const budgetEnd = Math.min(request.deadline ?? Number.POSITIVE_INFINITY, started + env.AI_ROUTING_BUDGET_MS);
  const wantsTools = Boolean(request.tools && request.tools.length > 0);
  const plan = request.candidatesOverride
    ? { eligible: request.candidatesOverride, skipped: [] as SkippedRoute[], freeOnly: getBusinessSettings(accountId).aiFreeOnly, failover: getBusinessSettings(accountId).aiFailoverEnabled }
    : await buildCandidates(accountId, request.task, { needs: request.needs, wantsTools });
  const attempts: RouteAttempt[] = [];
  const errors: unknown[] = [];
  const skipped = [...plan.skipped];
  const maxAttempts = plan.failover ? env.AI_ROUTE_MAX_ATTEMPTS : 1;
  const queue = plan.eligible.slice(0, maxAttempts);
  for (const c of plan.eligible.slice(maxAttempts)) skipped.push({ candidate: c, category: 'limit', reason: `beyond the ${maxAttempts}-route limit for one message` });

  for (let i = 0; i < queue.length; i += 1) {
    const candidate = queue[i]!;
    const now = Date.now();
    if (now + MIN_ATTEMPT_MS > budgetEnd) { skipped.push({ candidate, category: 'no_time', reason: 'no time left in the routing budget' }); continue; }
    const timeoutMs = Math.min(candidate.timeoutMs, budgetEnd - now);
    const messages = candidate.local && request.compactMessages ? request.compactMessages : request.messages;
    const onlyRoute = queue.length === 1;
    for (let attempt = 0; attempt < (onlyRoute ? 2 : 1); attempt += 1) {
      const t0 = Date.now();
      try {
        const response = await completeOnce({
          baseUrl: candidate.baseUrl, apiKey: candidate.apiKey, model: candidate.model, messages, tools: candidate.local && request.compactMessages ? undefined : request.tools, temperature: request.temperature, maxTokens: request.maxTokens, // the lean local prompt is text-only: no tool schemas to process
          timeoutMs: Math.min(timeoutMs, Math.max(MIN_ATTEMPT_MS, budgetEnd - Date.now())), headers: candidate.kind === 'openrouter' ? openRouterHeaders() : undefined,
        });
        const latencyMs = Date.now() - t0;
        const record: RouteAttempt = { candidate, outcome: 'ok', category: null, httpStatus: 200, latencyMs, detail: null };
        attempts.push(record);
        recordRouteAttempt({ accountId, task: request.task, providerId: candidate.providerId, providerName: candidate.providerName, model: candidate.model, outcome: 'ok', latencyMs });
        if (i > 0 || attempt > 0) logger.info({ account: accountId, task: request.task, provider: candidate.providerName, model: candidate.model, after: attempts.slice(0, -1).map((a) => `${a.candidate.providerName}/${a.candidate.model}:${a.category}`), latencyMs }, 'AI route answered after a failover');
        const servedBy = { model: candidate.model, provider: candidate.providerName, source: candidate.local ? 'local' as const : 'cloud' as const, ...(attempts.length > 1 ? { fallbackFrom: `${attempts[0]!.candidate.providerName} · ${attempts[0]!.candidate.model}`, fallbackReason: attempts[0]!.category ?? 'failed' } : {}) };
        // The route information travels with the answer; the key never does.
        return { ...response, servedBy, route: { candidate: publicCandidate(candidate), attempts: attempts.map((a) => ({ ...a, candidate: publicCandidate(a.candidate) })), skipped: skipped.map((s) => ({ ...s, candidate: publicCandidate(s.candidate) })), source: candidate.local ? 'local' : 'cloud', totalMs: Date.now() - started } };
      } catch (error) {
        const latencyMs = Date.now() - t0;
        const category = classifyRouteFailure(error);
        const responseError = error instanceof AiResponseError ? error : null;
        const record: RouteAttempt = { candidate, outcome: 'failed', category, httpStatus: responseError?.httpStatus ?? (error instanceof AiCredentialError ? error.httpStatus ?? null : null), latencyMs, detail: responseError?.providerMessage ?? (error instanceof AiCredentialError ? 'key rejected' : null) };
        attempts.push(record);
        errors.push(error);
        recordRouteAttempt({ accountId, task: request.task, providerId: candidate.providerId, providerName: candidate.providerName, model: candidate.model, outcome: 'failed', category, httpStatus: record.httpStatus, latencyMs, detail: record.detail });
        logger.warn({ account: accountId, task: request.task, provider: candidate.providerName, model: candidate.model, category, reason: responseError?.reason ?? (error instanceof AiCredentialError ? 'credential' : 'unknown'), httpStatus: record.httpStatus, latencyMs, local: candidate.local }, 'AI route failed');
        // One bounded retry against the SAME route only when it is the only eligible route and the failure is transient.
        const transient = category === 'rate_limited' || category === 'provider_error' || category === 'empty' || category === 'network' || category === 'timeout';
        if (onlyRoute && attempt === 0 && transient && Date.now() + MIN_ATTEMPT_MS + 300 < budgetEnd) { await new Promise((r) => setTimeout(r, 300)); continue; }
        markFailure(request.task, candidate, category, responseError);
        break;
      }
    }
    if (!plan.failover) break;
  }

  // nothing answered: the first failure is the headline (it names the primary cause), the rest is attached
  if (!attempts.length && skipped.length && skipped.every((s) => s.category === 'no_key' || s.category === 'disabled') && skipped.some((s) => s.category === 'no_key')) {
    // Every route needs a key and none has a usable one: that is a credential problem for staff to fix, not a model failure.
    const malformed = skipped.some((s) => s.category === 'no_key' && /not a usable key/.test(s.reason));
    throw malformed
      ? new AiCredentialError('The configured OpenRouter API key is not a usable key. Enter a valid one in the dashboard (Providers).', 'malformed')
      : new AiCredentialError('No usable AI provider key is saved. Enter one in the dashboard (Providers).', 'missing');
  }
  const first = errors[0];
  const headline = first instanceof AiResponseError
    ? first
    : first instanceof AiCredentialError
      ? first
      : new AiResponseError(attempts[0] ? reasonOf(attempts[0].category ?? 'provider_error') : 'model_unavailable', attempts[0]?.httpStatus ?? null, attempts[0] ? `${attempts[0].candidate.providerName} · ${attempts[0].candidate.model}` : null, attempts.length ? null : 'no eligible AI route');
  if (headline instanceof AiResponseError) {
    headline.attempts = attempts.map((a, idx) => attemptRecord(a, errors[idx]));
    const skippedText = skipped.map((s) => `${s.candidate.providerName} · ${s.candidate.model}: ${s.reason}`).join('; ');
    headline.fallbackSkipped = skippedText || (attempts.length ? null : 'no AI route is configured for this business');
    if (!attempts.length && plan.freeOnly && skipped.some((s) => s.category === 'free_only')) headline.fallbackSkipped = `strict free-only mode: ${skippedText}`;
  }
  throw headline;
}

/** The live routing plan for one business and task, for the dashboard: eligible routes in order and why the others are not used. */
export async function explainRoutes(accountId: number, task: AiTask): Promise<{ eligible: Array<Omit<RouteCandidate, 'apiKey'>>; skipped: Array<{ route: Omit<RouteCandidate, 'apiKey'>; category: SkipCategory; reason: string }>; freeOnly: boolean; failover: boolean }> {
  const plan = await buildCandidates(accountId, task, { needs: task === 'vision' ? { image: true } : task === 'audio' ? { audio: true } : undefined, wantsTools: task === 'chat' });
  const strip = (c: RouteCandidate): Omit<RouteCandidate, 'apiKey'> => { const { apiKey: _k, ...rest } = c; return rest; };
  return { eligible: plan.eligible.map(strip), skipped: plan.skipped.map((s) => ({ route: strip(s.candidate), category: s.category, reason: s.reason })), freeOnly: plan.freeOnly, failover: plan.failover };
}

/** True when a local inference route exists for this business (built-in env route or a configured, enabled Ollama provider). */
export function hasLocalRoute(accountId: number): boolean {
  if (env.OLLAMA_BASE_URL && csv(env.OLLAMA_MODELS).length > 0) return true;
  return listProvidersForAccount(accountId).some((p) => p.kind === 'ollama' && p.enabled !== 0 && csv(p.models).length > 0);
}

export function resetAiRouterForTests(): void {
  routeCooling.clear();
  providerCooling.clear();
}

/** Every cooldown currently active (for the dashboard health view). */
export function activeCooldowns(now = Date.now()): Array<{ key: string; until: number; why: string }> {
  const out: Array<{ key: string; until: number; why: string }> = [];
  for (const [key, entry] of [...routeCooling, ...providerCooling]) if (entry.until > now) out.push({ key, until: entry.until, why: entry.why });
  return out;
}
