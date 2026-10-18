import { getDb } from '../memory/db';
import { getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { getBusinessSettings } from '../config/businessSettings';
import { runWithAccount } from '../accounts/accountContext';
import { csv, listProvidersForAccount, listSharedProviders, providerApiKey, type AiProviderRow } from '../llm/providerRepo';
import { DEFAULT_ENTRY, getAccountRouting, providerEntryKey } from '../llm/routingOrder';
import { getCachedProviderHealth } from '../llm/aiProviderHealth';
import { coolingUntil } from '../llm/aiRouter';
import type { AiState } from './overview';

/**
 * The AI status of one business when it is served by configured PROVIDERS (the shared Default pool and/or its own): judged from the routing
 * configuration and what the router actually observed (ai_route_log), never from the legacy built-in OPENROUTER_API_KEY slot alone.
 *
 *  1. Which routes can this business use? (enabled, a readable key, a chat model, free-tier eligible under strict free-only mode, entry switched on)
 *  2. What happened on each route the last time it was used? (its latest logged attempt; shared providers across ALL businesses so that every
 *     business sees the same truth about a shared provider)
 *  3. A route that answered → healthy (even if another route failed: that is failover working); otherwise the newest failure, named by its
 *     real category and sanitized reason; no evidence yet → configured, not confirmed.
 *
 * The legacy built-in key is judged only when the built-in route really participates; otherwise it is reported as an inactive legacy slot and
 * never changes the status. No network call is made here.
 */
const DAY_MS = 86_400_000;
const sqlTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const dbTimeMs = (value: string): number => Date.parse(`${value.replace(' ', 'T')}Z`);

interface Inventory {
  eligible: AiProviderRow[];
  builtinInUse: boolean;
  builtinKeyPresent: boolean;
  reasons: string[];
  hasProviders: boolean;
}

function inventory(accountId: number): Inventory {
  const settings = runWithAccount(accountId, () => getBusinessSettings(accountId));
  const routing = getAccountRouting(accountId);
  const off = new Set(routing.filter((r) => !r.enabled).map((r) => r.key));
  const rows = listProvidersForAccount(accountId);
  const reasons: string[] = [];
  const eligible: AiProviderRow[] = [];
  for (const row of rows) {
    const entry = row.whatsapp_account_id === null ? DEFAULT_ENTRY : providerEntryKey(row.id);
    if (off.has(entry)) { reasons.push(row.whatsapp_account_id === null ? 'the Default entry is switched off for this business' : `${row.name}: switched off for this business`); continue; }
    if (row.enabled === 0) { reasons.push(`${row.name}: turned off`); continue; }
    if (providerApiKey(row) === null) { reasons.push(`${row.name}: no usable key`); continue; }
    if (csv(row.models).length === 0) { reasons.push(`${row.name}: no chat model`); continue; }
    if (settings.aiFreeOnly && row.kind !== 'openrouter' && (row.free_tier === 0 || row.free_confirmed === 0)) { reasons.push(`${row.name}: ${row.free_tier === 0 ? 'declared as paid' : 'free tier not confirmed'}`); continue; }
    eligible.push(row);
  }
  const defaultOn = !off.has(DEFAULT_ENTRY);
  const sharedOpenRouter = listSharedProviders().some((r) => r.kind === 'openrouter' && csv(r.models).length > 0);
  const builtinKeyPresent = isUsableApiKey(getEffectiveCredential('OPENROUTER_API_KEY'));
  return { eligible, builtinInUse: defaultOn && !sharedOpenRouter && builtinKeyPresent, builtinKeyPresent, reasons, hasProviders: rows.length > 0 };
}

export type ProviderHealthState = 'off' | 'no_key' | 'config_error' | 'ineligible' | 'cooling' | 'rate_limited' | 'invalid_credentials' | 'request_failed' | 'ok' | 'available' | 'untested';

export interface ProviderHealth {
  state: ProviderHealthState;
  /** Short badge text. */
  label: string;
  /** One line for the card (never longer than 100 characters). */
  summary: string;
  /** The full sanitized explanation, for the expandable details. */
  detail: string;
}

const utc = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const clip = (s: string, n = 100): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What ONE provider is doing right now, from facts only (never from "a key is saved"): turned off, no usable key, no model, not eligible under
 * strict free-only mode, cooling down (with the time it becomes eligible again), the category of its latest failure, a successful inference
 * from the routing history, or a passed test that no customer request has confirmed yet.
 */
export function providerHealth(row: AiProviderRow, now: number = Date.now(), freeOnly = true): ProviderHealth {
  const models = csv(row.models);
  const make = (state: ProviderHealthState, label: string, summary: string, detail = summary): ProviderHealth => ({ state, label, summary: clip(summary), detail });
  if (row.enabled === 0) return make('off', 'Off', 'Turned off — never used for replies.');
  if (providerApiKey(row) === null) return make('no_key', 'No usable key', 'No usable API key is saved. Edit the provider and enter the key again.');
  if (models.length === 0) return make('config_error', 'Configuration error', 'No chat model is set. Edit the provider and type a model id, or add the key again so a working model is chosen automatically.');
  if (freeOnly && row.kind !== 'openrouter' && (row.free_tier === 0 || row.free_confirmed === 0)) {
    return make('ineligible', 'Not eligible', row.free_tier === 0 ? 'Declared as paid — never used while free-only mode is on.' : 'Free tier not confirmed — not used until you confirm it.');
  }
  // The newest logged chat attempt on any of this provider's models (last 24 h).
  const marks = models.map(() => '?').join(',');
  const last = getDb().prepare(
    `SELECT model, outcome, category, http_status, detail, created_at FROM ai_route_log WHERE provider_id = ? AND task = 'chat' AND outcome IN ('ok','failed') AND created_at >= ? AND model IN (${marks}) ORDER BY id DESC LIMIT 1`,
  ).get(row.id, sqlTime(now - DAY_MS), ...models) as { model: string; outcome: 'ok' | 'failed'; category: string | null; http_status: number | null; detail: string | null; created_at: string } | undefined;
  const failure = last?.outcome === 'failed' && last.category !== 'context' ? describeRouteFailure({ category: last.category, http_status: last.http_status, detail: last.detail, provider_name: row.name, model: last.model }) : null;

  const cooling = coolingUntil(`provider:${row.id}`, now) ?? models.map((m) => coolingUntil(`chat:${row.id}:${m}`, now)).find(Boolean) ?? null;
  if (cooling) {
    const quota = /rate limited|credit/.test(cooling.why);
    return make(quota ? 'rate_limited' : 'cooling', quota ? 'Rate limited / quota exhausted' : 'Cooling down', `${quota ? 'Rate limit or free quota reached' : `Resting (${cooling.why})`} — eligible again at ${utc(cooling.until)}.`, `${failure ? `${failure.detail}. ` : ''}No request is sent to this provider until ${utc(cooling.until)}.`);
  }
  if (last?.outcome === 'ok') return make('ok', 'Successful inference', `Answered at ${utc(dbTimeMs(last.created_at))} · ${last.model}`);
  if (failure && last) {
    const cat = last.category;
    const state: ProviderHealthState = cat === 'auth' ? 'invalid_credentials' : cat === 'rate_limited' || cat === 'credit' ? 'rate_limited' : cat === 'model_unavailable' || cat === 'policy' || cat === 'capability' ? 'config_error' : 'request_failed';
    const label = { invalid_credentials: 'Invalid credentials', rate_limited: 'Rate limited / quota exhausted', config_error: 'Configuration error', request_failed: 'Request failed' }[state as 'invalid_credentials' | 'rate_limited' | 'config_error' | 'request_failed'];
    return make(state, label, failure.label + (last.http_status ? ` (HTTP ${last.http_status})` : '') + ' — retried automatically.', `${failure.detail}.`);
  }
  if (row.last_test_ok === 1) return make('available', 'Available', `Test passed at ${row.last_test_at ?? '?'} — no customer request has used it yet.`, row.last_test_detail ?? 'The provider test passed.');
  if (row.last_test_ok === 0) return make('request_failed', 'Test failed', row.last_test_detail ?? 'The last provider test failed.', row.last_test_detail ?? 'The last provider test failed.');
  return make('untested', 'Not tested', 'Configured and eligible. Press Test to check it.');
}

/** True when the legacy built-in OpenRouter key is what serves this business (no configured provider, or the built-in route participates): only then are its key and model worth checking. */
export function legacyRouteInUse(accountId: number): boolean {
  const inv = inventory(accountId);
  return !inv.hasProviders || inv.builtinInUse;
}

/** Provider wording made safe for a status line: no key-like token, no HTML page, bounded length. */
export function sanitizeProviderReason(raw: string | null | undefined): string {
  if (!raw) return '';
  if (/^\s*<(!doctype|html)/i.test(raw)) return 'the address answered a web page, not an API';
  return raw.replace(/\b(sk-[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{8,}|AIza[0-9A-Za-z_-]{10,}|xai-[A-Za-z0-9]{8,}|csk-[A-Za-z0-9]{8,})/g, '[key]').replace(/\s+/g, ' ').slice(0, 120).trim();
}

interface Latest { provider_id: number | null; model: string; outcome: 'ok' | 'failed'; category: string | null; http_status: number | null; detail: string | null; provider_name: string; created_at: string }

/** The honest label for a failed route, from its real category (never one generic label). */
export function describeRouteFailure(f: Pick<Latest, 'category' | 'http_status' | 'detail' | 'provider_name' | 'model'>): { label: string; detail: string } {
  const reason = sanitizeProviderReason(f.detail);
  const http = f.http_status ? ` (HTTP ${f.http_status})` : '';
  const where = `${f.provider_name} · ${f.model}`;
  const tail = reason ? `: ${reason}` : '';
  switch (f.category) {
    case 'auth': return { label: 'AI key rejected', detail: `${f.provider_name} rejected its API key${http}${tail}` };
    case 'credit': return { label: 'AI credits exhausted', detail: `${where}${http}: credit or free allowance exhausted${tail}` };
    case 'rate_limited': {
      const daily = /per[- ]day|daily|quota/i.test(reason);
      return { label: daily ? 'AI free quota reached' : 'AI rate limit reached', detail: `${where}${http}${daily ? ': daily free allowance used up' : ': too many requests'}${tail}; it is retried later and nothing is purchased` };
    }
    case 'policy': return { label: 'AI request rejected by provider policy', detail: `${where}${http}${tail}` };
    case 'capability': return { label: 'AI model lacks a needed capability', detail: `${where}${http}${tail}` };
    case 'model_unavailable':
      return /web page/.test(reason)
        ? { label: 'AI provider address is not an API', detail: `${f.provider_name}${http}: ${reason}. Check the endpoint address` }
        : { label: 'AI model unavailable', detail: `${where}${http}${tail}` };
    case 'timeout': case 'network': case 'provider_error': return { label: 'AI provider temporarily unavailable', detail: `${where}${http}${tail || ': no answer in time'}` };
    case 'empty': case 'malformed': return { label: 'AI returned an unusable response', detail: `${where}: ${f.category === 'empty' ? 'an empty answer' : 'an unreadable answer'}${http}` };
    default: return { label: 'AI replies failing', detail: `${where}${http}${tail}` };
  }
}

/**
 * null when this business has no configured provider at all (the legacy built-in-key evaluation then applies unchanged); otherwise the
 * pool-based state.
 */
export function getPoolAiState(accountId: number, now: number, base: { model: string | null }): AiState | null {
  const inv = inventory(accountId);
  if (!inv.hasProviders) return null;
  const known = { verified: false, model: base.model, modelVerified: false };
  const legacyHealth = getCachedProviderHealth(now);
  const legacyNote = !inv.builtinInUse && inv.builtinKeyPresent && legacyHealth?.status === 'rejected'
    ? ` Legacy OpenRouter key slot: rejected (HTTP ${legacyHealth.httpStatus ?? 401}), inactive — not used for replies.`
    : '';

  if (inv.eligible.length === 0 && !inv.builtinInUse) {
    return { ...known, state: 'error', label: 'No available free route', detail: `Providers are configured but none can answer: ${inv.reasons.slice(0, 4).join('; ') || 'none is eligible'}.${legacyNote}` };
  }

  // The latest logged chat attempt of every route this business can use (shared providers: from every business).
  const ids = inv.eligible.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const rows = getDb().prepare(
    `SELECT l.provider_id, l.model, l.outcome, l.category, l.http_status, l.detail, l.provider_name, l.created_at
       FROM ai_route_log l
       JOIN (SELECT MAX(id) AS id FROM ai_route_log WHERE task = 'chat' AND outcome IN ('ok','failed') AND created_at >= ?
              AND (${ids.length ? `provider_id IN (${marks})` : '0'}${inv.builtinInUse ? ' OR provider_id IS NULL' : ''}) GROUP BY provider_id, model) m ON m.id = l.id`,
  ).all(sqlTime(now - DAY_MS), ...ids) as Latest[];
  const byId = new Map(inv.eligible.map((r) => [r.id, r]));
  const current = rows.filter((r) => (r.provider_id === null ? inv.builtinInUse : csv(byId.get(r.provider_id)?.models).includes(r.model)));
  const newestFirst = (a: Latest, b: Latest): number => b.created_at.localeCompare(a.created_at);
  const ok = current.filter((r) => r.outcome === 'ok').sort(newestFirst);
  const bad = current.filter((r) => r.outcome === 'failed' && r.category !== 'context').sort(newestFirst);

  if (ok.length) {
    const best = ok[0]!;
    const later = bad.filter((b) => b.created_at > best.created_at);
    const note = later.length ? ` ${later.length} other route${later.length === 1 ? '' : 's'} failed since (${[...new Set(later.map((o) => describeRouteFailure(o).label))].join(', ')}).` : '';
    return { state: 'active', label: 'AI active', detail: `${best.provider_name} · ${best.model} answered at ${new Date(dbTimeMs(best.created_at)).toISOString().slice(11, 16)} UTC.${note}${legacyNote}`, verified: true, model: best.model, modelVerified: true };
  }
  if (bad.length) {
    const { label, detail } = describeRouteFailure(bad[0]!);
    // Several routes, none answering: say so, and name every route's own reason (not just the newest one).
    const others = bad.slice(1).map((b) => `${b.provider_name} · ${b.model}: ${describeRouteFailure(b).label}`);
    const all = others.length ? ` No route is answering — also: ${others.join('; ')}.` : '';
    return { ...known, model: bad[0]!.model, state: 'error', label: others.length ? `No provider is answering — ${label}` : label, detail: `${detail}.${all}${legacyNote}` };
  }
  // No attempt on any usable route in the last 24 h: configured, nothing confirmed. A rejected built-in key counts only when that route is in use.
  if (inv.builtinInUse && inv.eligible.length === 0 && legacyHealth?.status === 'rejected') {
    return { ...known, state: 'error', label: 'AI key rejected', detail: `OpenRouter rejected the saved key (HTTP ${legacyHealth.httpStatus ?? 401}). Save a valid key under Providers.` };
  }
  const n = inv.eligible.length + (inv.builtinInUse ? 1 : 0);
  return { ...known, state: 'active', label: 'AI active', detail: `${n} eligible route${n === 1 ? '' : 's'} configured; no request in the last 24 hours, so nothing is confirmed yet.${legacyNote}` };
}
