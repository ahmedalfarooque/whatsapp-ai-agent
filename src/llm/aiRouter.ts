import { env } from '../config/env';
import { getBusinessSettings } from '../config/businessSettings';
import { getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { currentAccountId } from '../accounts/accountContext';
import { logger } from '../logger';
import { getDb } from '../memory/db';
import { AiCredentialError } from './aiCredentialError';
import { AiResponseError, type AiResponseReason, type ModelAttemptRecord } from './aiResponseError';
import { adapterFor } from './adapters';
import { getModelInfo } from './modelCatalog';
import { csv, listProvidersForAccount, listSharedProviders, providerApiKey, type AiProviderRow, type ProviderKind } from './providerRepo';
import { recordRouteAttempt } from './routeLog';
import { DEFAULT_ENTRY, getAccountRouting, providerEntryKey } from './routingOrder';
import type { ChatCompletionResponse, ChatMessage } from './types';
import type { ToolDefinition } from '../tools';

/**
 * The central AI routing layer: every AI task (chat, picture analysis, voice transcription) goes through here.
 *
 *  Order of routes: the business's saved order (routingOrder.ts): its Default entry (the shared pool the Super Admin manages, then the
 *  server's built-in OpenRouter key when no shared OpenRouter provider exists) and its own providers; finally the pipeline's deterministic
 *  customer-service fallback (not here).
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
export type SkipCategory = 'disabled' | 'no_key' | 'cooldown' | 'recovering' | 'free_only' | 'capability' | 'no_time' | 'limit';

export interface RouteCandidate {
  key: string;
  providerKey: string;
  providerId: number | null;
  providerName: string;
  kind: ProviderKind;
  /** Which adapter speaks this route's API (openrouter | openai | gemini). */
  adapter: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  free: boolean | null;
  image: boolean | null;
  audio: boolean | null;
  tools: boolean | null;
  timeoutMs: number;
  builtin: boolean;
}

export interface SkippedRoute { candidate: RouteCandidate; category: SkipCategory; reason: string }

export interface RouteRequest {
  task: AiTask;
  messages: ChatMessage[];
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
  route: { candidate: RouteCandidate; attempts: RouteAttempt[]; skipped: SkippedRoute[]; totalMs: number };
}

// Inside the Default entry the shared providers (priority 1-499, set by the Super Admin's order) come first, then the server's built-in OpenRouter key.
export const BUILTIN_OPENROUTER_PRIORITY = 500;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const MIN_ATTEMPT_MS = 1500;

// Test hook only: the test suite stubs the network, so OpenRouter's catalog is never read and every model's price is unknown; strict
// free-only mode would (correctly) skip them all. Tests that exercise the client opt in to "unknown price = allowed"; tests of the
// fail-closed rule switch it off again. Production never sets this.
let unknownPriceAllowedInTests = false;
export function allowUnknownPriceForTests(flag: boolean): void { unknownPriceAllowedInTests = flag; }

// ---- cooldowns and recovery ----------------------------------------------------------------------------------------------------------
/**
 * One state per route key (task + provider + model) or per provider key. It lives in memory AND in ai_route_cooldowns, so a restart does not forget a pause (a
 * freshly started process would otherwise hammer a provider that just reported "quota exhausted"). `resetKnown` means the end of the pause is a reset time the
 * PROVIDER stated (Retry-After, X-RateLimit-Reset, Google's RetryInfo or daily reset); otherwise it is our own bounded backoff (doubling per consecutive failure up
 * to a cap) and is shown as an estimate, never as a reset time. The state stays after the pause ends until a success clears it (or six quiet hours pass): the next
 * failure continues the backoff, and a route that failed before is tested by ONE request at a time when it comes back (the trial lock in routeCompletion).
 */
export interface RouteState { scope: 'route' | 'provider'; until: number; why: string; category: string | null; resetKnown: boolean; strikes: number; setAt: number }
const states = new Map<string, RouteState>();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const STRIKE_MEMORY_MS = 6 * HOUR;
const STATE_KEEP_MS = 24 * HOUR;

function loadState(key: string): RouteState | undefined {
  let s = states.get(key);
  if (!s) {
    // A pause set before a restart: read it back once and keep it in memory (a missing table or database means "none").
    try {
      const row = getDb().prepare('SELECT scope, until_ms, why, category, reset_known, strikes, set_at_ms FROM ai_route_cooldowns WHERE key = ?').get(key) as { scope: 'route' | 'provider'; until_ms: number; why: string; category: string | null; reset_known: number; strikes: number; set_at_ms: number | null } | undefined;
      if (row) { s = { scope: row.scope, until: row.until_ms, why: row.why, category: row.category, resetKnown: row.reset_known === 1, strikes: row.strikes, setAt: row.set_at_ms ?? row.until_ms }; states.set(key, s); }
    } catch { /* not persisted */ }
  }
  return s;
}

/** The pause that is still running for this key (null once it has ended: the state itself stays for the backoff and the trial lock). */
export function coolingUntil(key: string, now = Date.now()): RouteState | null {
  const s = loadState(key);
  return s && s.until > now ? s : null;
}

/** A route that just ANSWERED is available, whatever an earlier failure said (a test, a probe or a replay can reach it while it rests): its state ends. */
function clearCooldowns(keys: string[]): void {
  for (const key of keys) {
    states.delete(key);
    try { getDb().prepare('DELETE FROM ai_route_cooldowns WHERE key = ?').run(key); } catch { /* not persisted */ }
  }
}

function persistState(key: string, s: RouteState): void {
  try {
    const db = getDb();
    db.prepare(`INSERT INTO ai_route_cooldowns (key, scope, until_ms, why, category, reset_known, strikes, set_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET scope = excluded.scope, until_ms = excluded.until_ms, why = excluded.why, category = excluded.category, reset_known = excluded.reset_known, strikes = excluded.strikes, set_at_ms = excluded.set_at_ms, updated_at = datetime('now')`)
      .run(key, s.scope, s.until, s.why, s.category, s.resetKnown ? 1 : 0, s.strikes, s.setAt);
    db.prepare('DELETE FROM ai_route_cooldowns WHERE until_ms < ?').run(s.setAt - STATE_KEEP_MS); // old, long-ended states are not kept for ever
  } catch { /* the in-memory state still protects this process */ }
}

/** Bounded exponential backoff: base × 2^(failures-1), never more than the cap. Used only when the provider did not say when the limit lifts. */
export const backoffMs = (baseMs: number, capMs: number, strikes: number): number => Math.min(baseMs * 2 ** Math.max(0, strikes - 1), capMs);
const RETIRED = /no longer available|deprecated|retired|discontinued/i;

/**
 * How long a failed route rests. A reset time the provider STATED is honoured as given (never invented, never shortened); when it did not say, the pause is a bounded
 * backoff that doubles with each consecutive failure up to a cap, so an exhausted provider is retried later and later, not every minute. `strikes` = consecutive failures.
 */
export function cooldownFor(category: FailureCategory, error: AiResponseError | null, strikes = 1): { ms: number; scope: 'route' | 'provider'; resetKnown: boolean } {
  const message = error?.providerMessage ?? '';
  switch (category) {
    // A prompt that is too long for THIS model says nothing about the route: a shorter prompt may fit.
    case 'context': return { ms: 0, scope: 'route', resetKnown: false };
    case 'auth': return { ms: backoffMs(10 * MINUTE, HOUR, strikes), scope: 'provider', resetKnown: false };
    case 'credit': return { ms: backoffMs(30 * MINUTE, 6 * HOUR, strikes), scope: 'provider', resetKnown: false };
    case 'policy': return { ms: backoffMs(30 * MINUTE, 2 * HOUR, strikes), scope: 'route', resetKnown: false };
    case 'capability': return { ms: HOUR, scope: 'route', resetKnown: false };
    case 'rate_limited': {
      // A DAILY allowance does not recover in a minute (production once called an exhausted provider ~28 times in 6 h) and, being account-wide, rests the provider.
      const daily = /per[- ]day|daily/i.test(message);
      const quota = daily || /quota/i.test(message);
      const scope = quota ? 'provider' : 'route';
      const stated = error?.retryAfterMs ?? 0;
      if (daily) {
        const floor = backoffMs(30 * MINUTE, 2 * HOUR, strikes); // a short hint on a daily limit must not make us retry within seconds
        return { ms: Math.max(stated, floor), scope, resetKnown: stated >= floor };
      }
      if (stated > 0) {
        const lengthened = strikes > 2 ? backoffMs(MINUTE, 15 * MINUTE, strikes - 2) : 0; // repeated failure at the stated time lengthens it, never shortens it
        return { ms: Math.max(stated, lengthened, 1000), scope, resetKnown: stated >= lengthened };
      }
      return { ms: quota ? backoffMs(5 * MINUTE, HOUR, strikes) : backoffMs(MINUTE, 15 * MINUTE, strikes), scope, resetKnown: false };
    }
    // A model the provider itself says is retired will not come back in five minutes: rest it an hour (an unknown or misspelt model backs off from five).
    case 'model_unavailable': return { ms: RETIRED.test(message) ? HOUR : backoffMs(5 * MINUTE, HOUR, strikes), scope: 'route', resetKnown: false };
    case 'timeout': return { ms: backoffMs(MINUTE, 15 * MINUTE, strikes), scope: 'route', resetKnown: false };
    case 'network': return { ms: backoffMs(MINUTE, 15 * MINUTE, strikes), scope: 'provider', resetKnown: false };
    case 'provider_error': return { ms: backoffMs(MINUTE, 15 * MINUTE, strikes), scope: 'route', resetKnown: false };
    // One empty or malformed answer says nothing about the next one: no cooldown (the failure is still logged and counted).
    case 'empty':
    case 'malformed': return { ms: 0, scope: 'route', resetKnown: false };
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
  // The declaration is not enough on its own: the price of a non-OpenRouter endpoint cannot be verified here, so the Super Admin must confirm
  // the free tier (free_confirmed); until then the route's price is "unknown" and strict free-only mode skips it.
  const free = row ? (row.free_tier === 0 ? false : row.free_confirmed === 0 ? null : true) : true;
  return { free, image: task === 'vision' ? true : null, audio: task === 'audio' ? true : null, tools: row ? row.supports_tools !== 0 : true };
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
    const apiKey = providerApiKey(row);
    const disabled = row.enabled === 0 ? 'provider disabled' : !apiKey ? (row.key_ciphertext ? 'the stored key cannot be read (enter it again)' : 'no API key saved') : undefined;
    for (const model of models) {
      const facts = await describeModel(row.kind, model, row, task);
      all.push({ priority: row.priority, order: order++, disabled, entryKey, candidate: {
        key: `${row.id}:${model}`, providerKey: `provider:${row.id}`, providerId: row.id, providerName: row.name, kind: row.kind, adapter: row.adapter, baseUrl: row.base_url, apiKey, model, ...facts,
        timeoutMs: row.timeout_ms, builtin: false,
      } });
    }
  }

  // 2. the built-in OpenRouter route (the dashboard / .env key with the business's own models). Once the Super Admin has a shared OpenRouter
  // provider in the Default pool (the key adopted into it), that provider IS the OpenRouter entry: the built-in route stays out of the way so
  // one key is never tried twice and turning the shared provider off really turns OpenRouter off.
  const builtinKey = getEffectiveCredential('OPENROUTER_API_KEY');
  const sharedOpenRouter = task === 'chat' && listSharedProviders().some((r) => r.kind === 'openrouter' && csv(r.models).length > 0);
  const builtinModels = task === 'chat'
    ? [settings.openRouterModel, ...settings.openRouterFallbackModels]
    : task === 'vision'
      ? [settings.openRouterVisionModel, settings.openRouterModel, ...settings.openRouterFallbackModels]
      : settings.openRouterAudioModel ? [settings.openRouterAudioModel] : [];
  const seen = new Set<string>();
  for (const model of sharedOpenRouter ? [] : builtinModels) {
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const facts = await describeModel('openrouter', model, null, task);
    // The business's own vision / chat model was configured for pictures by the administrator: with the catalog unavailable it is still
    // tried (that is exactly what worked on production); a generic fallback with unknown capability is not.
    const explicit = task === 'vision' && (model === settings.openRouterVisionModel || model === settings.openRouterModel);
    all.push({ priority: BUILTIN_OPENROUTER_PRIORITY, order: order++, entryKey: DEFAULT_ENTRY, disabled: isUsableApiKey(builtinKey) ? undefined : builtinKey.trim() ? 'the saved OpenRouter key is not a usable key (wrong format or length)' : 'no OpenRouter key saved', candidate: {
      key: `builtin:${model}`, providerKey: 'provider:builtin', providerId: null, providerName: 'OpenRouter (built-in key)', kind: 'openrouter', adapter: 'openrouter', baseUrl: OPENROUTER_BASE_URL, apiKey: isUsableApiKey(builtinKey) ? builtinKey : null, model,
      free: facts.free, image: facts.image ?? (explicit ? true : null), audio: facts.audio, tools: facts.tools, timeoutMs: env.OPENROUTER_TIMEOUT_MS, builtin: true,
    } });
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
    if (freeOnly && c.free !== true && !(c.free === null && unknownPriceAllowedInTests)) { skipped.push({ candidate: c, category: 'free_only', reason: c.free === false ? 'this route costs money (strict free-only mode)' : c.builtin || c.kind === 'openrouter' ? 'price unknown — treated as paid (strict free-only mode)' : 'free tier not confirmed yet — the Super Admin or business must confirm it (strict free-only mode)' }); continue; }
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

const META_ROUTER_MODEL = /^openrouter\/(free|auto)$/;

function markFailure(task: AiTask, candidate: RouteCandidate, category: FailureCategory, error: AiResponseError | null, now = Date.now()): void {
  const first = cooldownFor(category, error, 1);
  if (first.ms <= 0) return;
  const key = first.scope === 'provider' ? candidate.providerKey : routeCoolKey(task, candidate);
  const previous = loadState(key);
  // A failure counts as ANOTHER strike only when it comes after the previous pause ended (the route was tried again and failed again): sibling routes of one provider
  // failing inside the same message, or a failure while the pause still runs, are one event, not an escalation.
  const stillResting = previous !== undefined && previous.until > now;
  const strikes = previous && now - previous.setAt < STRIKE_MEMORY_MS ? (stillResting ? previous.strikes : previous.strikes + 1) : 1;
  const next = cooldownFor(category, error, strikes);
  // `openrouter/free` is a ROUTER over many free endpoints: a data-policy refusal there is about the endpoint it happened to pick for THIS request, not about the
  // model (the routing history shows a policy 404 followed by an answer seconds later), so it rests one minute, not half an hour.
  const routerPolicy = category === 'policy' && META_ROUTER_MODEL.test(candidate.model);
  const ms = routerPolicy ? Math.min(next.ms, MINUTE) : next.ms;
  const until = Math.max(now + ms, stillResting ? previous!.until : 0); // a pause that is already running is never shortened by a sibling failure
  const state: RouteState = { scope: next.scope, until, why: category.replace(/_/g, ' '), category, resetKnown: next.resetKnown && !routerPolicy && until === now + ms, strikes, setAt: stillResting ? previous!.setAt : now };
  states.set(key, state);
  persistState(key, state);
}

// A route that failed before comes back through ONE request at a time: while that trial is in flight, other requests for the same route wait for its result
// (it either clears the state or sets a new pause), so a recovering provider is never hit by a burst. Healthy routes have no state and no lock.
const trialsInFlight = new Map<string, Promise<void>>();
const TRIAL_WAIT_MS = 8000;

/** The state keys of a route that has failed recently (its pause may have ended): these are the ones a single trial request guards. */
function recoveringKeys(task: AiTask, candidate: RouteCandidate, now: number): string[] {
  return [routeCoolKey(task, candidate), candidate.providerKey].filter((k) => { const s = loadState(k); return s !== undefined && now - s.setAt < STRIKE_MEMORY_MS; });
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
    const messages = request.messages;
    const onlyRoute = queue.length === 1;

    // Recovery safety: a route that failed before is tested by one request at a time; the others wait for that result instead of piling on.
    let locks = recoveringKeys(request.task, candidate, now);
    const inFlight = locks.map((k) => trialsInFlight.get(k)).find((p) => p !== undefined);
    if (inFlight) {
      const waitMs = Math.min(TRIAL_WAIT_MS, Math.max(0, budgetEnd - Date.now() - MIN_ATTEMPT_MS));
      await Promise.race([inFlight, new Promise<void>((resolve) => { setTimeout(resolve, waitMs).unref?.(); })]);
      const resting = coolingUntil(routeCoolKey(request.task, candidate)) ?? coolingUntil(candidate.providerKey);
      if (resting) { skipped.push({ candidate, category: 'cooldown', reason: `cooling down until ${new Date(resting.until).toISOString().slice(11, 19)} UTC (${resting.why})` }); continue; }
      locks = recoveringKeys(request.task, candidate, Date.now());
      if (locks.some((k) => trialsInFlight.has(k))) { skipped.push({ candidate, category: 'recovering', reason: 'another request is still testing this route after its pause' }); continue; }
    }
    let releaseTrial: () => void = () => undefined;
    if (locks.length > 0) {
      const trial = new Promise<void>((resolve) => { releaseTrial = resolve; });
      for (const k of locks) trialsInFlight.set(k, trial);
    }
    try {
    for (let attempt = 0; attempt < (onlyRoute ? 2 : 1); attempt += 1) {
      const t0 = Date.now();
      try {
        // The adapter owns this vendor's request/response contract and error mapping; the router sees only a normalised answer or error.
        const response = await adapterFor(candidate.adapter).complete({
          baseUrl: candidate.baseUrl, apiKey: candidate.apiKey, model: candidate.model, messages, tools: request.tools, temperature: request.temperature, maxTokens: request.maxTokens,
          timeoutMs: Math.min(timeoutMs, Math.max(MIN_ATTEMPT_MS, budgetEnd - Date.now())),
        });
        const latencyMs = Date.now() - t0;
        clearCooldowns([routeCoolKey(request.task, candidate), candidate.providerKey]);
        const record: RouteAttempt = { candidate, outcome: 'ok', category: null, httpStatus: 200, latencyMs, detail: null };
        attempts.push(record);
        recordRouteAttempt({ accountId, task: request.task, providerId: candidate.providerId, providerName: candidate.providerName, model: candidate.model, outcome: 'ok', latencyMs });
        if (i > 0 || attempt > 0) logger.info({ account: accountId, task: request.task, provider: candidate.providerName, model: candidate.model, after: attempts.slice(0, -1).map((a) => `${a.candidate.providerName}/${a.candidate.model}:${a.category}`), latencyMs }, 'AI route answered after a failover');
        const servedBy = { model: candidate.model, provider: candidate.providerName, ...(attempts.length > 1 ? { fallbackFrom: `${attempts[0]!.candidate.providerName} · ${attempts[0]!.candidate.model}`, fallbackReason: attempts[0]!.category ?? 'failed' } : {}) };
        // The route information travels with the answer; the key never does.
        return { ...response, servedBy, route: { candidate: publicCandidate(candidate), attempts: attempts.map((a) => ({ ...a, candidate: publicCandidate(a.candidate) })), skipped: skipped.map((s) => ({ ...s, candidate: publicCandidate(s.candidate) })), totalMs: Date.now() - started } };
      } catch (error) {
        const latencyMs = Date.now() - t0;
        const category = classifyRouteFailure(error);
        const responseError = error instanceof AiResponseError ? error : null;
        const record: RouteAttempt = { candidate, outcome: 'failed', category, httpStatus: responseError?.httpStatus ?? (error instanceof AiCredentialError ? error.httpStatus ?? null : null), latencyMs, detail: responseError?.providerMessage ?? (error instanceof AiCredentialError ? 'key rejected' : null) };
        attempts.push(record);
        errors.push(error);
        recordRouteAttempt({ accountId, task: request.task, providerId: candidate.providerId, providerName: candidate.providerName, model: candidate.model, outcome: 'failed', category, httpStatus: record.httpStatus, latencyMs, detail: record.detail });
        logger.warn({ account: accountId, task: request.task, provider: candidate.providerName, model: candidate.model, category, reason: responseError?.reason ?? (error instanceof AiCredentialError ? 'credential' : 'unknown'), httpStatus: record.httpStatus, latencyMs }, 'AI route failed');
        // One bounded retry against the SAME route only when it is the only eligible route and the failure is transient.
        // A quota the provider says will not be back for a while (a daily allowance, or a reset/retry time of a second or more) is NEVER retried
        // within the same message: a second call would only hit the exhausted quota again.
        const quotaRests = category === 'rate_limited' && ((responseError?.retryAfterMs ?? 0) >= 1000 || /per[- ]day|daily/i.test(responseError?.providerMessage ?? ''));
        // An empty answer whose tokens went on hidden reasoning (finish_reason=length) is not a flaky provider: the same request would be empty again, so it is not repeated.
        const budgetSpent = category === 'empty' && /finish_reason=length|reasoning/.test(responseError?.providerMessage ?? '');
        const transient = !quotaRests && !budgetSpent && (category === 'rate_limited' || category === 'provider_error' || category === 'empty' || category === 'network' || category === 'timeout');
        if (onlyRoute && attempt === 0 && transient && Date.now() + MIN_ATTEMPT_MS + 300 < budgetEnd) { await new Promise((r) => setTimeout(r, 300)); continue; }
        markFailure(request.task, candidate, category, responseError);
        break;
      }
    }
    } finally {
      for (const k of locks) trialsInFlight.delete(k);
      releaseTrial();
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

export function resetAiRouterForTests(): void {
  states.clear();
  trialsInFlight.clear();
  try { getDb().prepare('DELETE FROM ai_route_cooldowns').run(); } catch { /* no database in this test */ }
}

/** Test hook: a restart forgets everything held in memory; the database keeps the pauses (this is what a restart looks like to the router). */
export function simulateRestartForTests(): void {
  states.clear();
  trialsInFlight.clear();
}

/** Every pause currently running (memory and database, so one set before a restart is included), for the dashboard health view. */
export function activeCooldowns(now = Date.now()): Array<{ key: string; until: number; why: string; resetKnown: boolean; category: string | null; strikes: number }> {
  const out = new Map<string, { key: string; until: number; why: string; resetKnown: boolean; category: string | null; strikes: number }>();
  try {
    const rows = getDb().prepare('SELECT key, until_ms, why, category, reset_known, strikes FROM ai_route_cooldowns WHERE until_ms > ?').all(now) as Array<{ key: string; until_ms: number; why: string; category: string | null; reset_known: number; strikes: number }>;
    for (const r of rows) out.set(r.key, { key: r.key, until: r.until_ms, why: r.why, resetKnown: r.reset_known === 1, category: r.category, strikes: r.strikes });
  } catch { /* not persisted */ }
  for (const [key, s] of states) if (s.until > now) out.set(key, { key, until: s.until, why: s.why, resetKnown: s.resetKnown, category: s.category, strikes: s.strikes });
  return [...out.values()];
}
