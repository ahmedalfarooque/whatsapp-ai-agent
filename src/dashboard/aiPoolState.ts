import { getDb } from '../memory/db';
import { getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { getBusinessSettings } from '../config/businessSettings';
import { runWithAccount } from '../accounts/accountContext';
import { csv, listProvidersForAccount, listSharedProviders, providerApiKey, type AiProviderRow } from '../llm/providerRepo';
import { DEFAULT_ENTRY, getAccountRouting, providerEntryKey } from '../llm/routingOrder';
import { getCachedProviderHealth } from '../llm/aiProviderHealth';
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
    return { ...known, model: bad[0]!.model, state: 'error', label, detail: `${detail}.${legacyNote}` };
  }
  // No attempt on any usable route in the last 24 h: configured, nothing confirmed. A rejected built-in key counts only when that route is in use.
  if (inv.builtinInUse && inv.eligible.length === 0 && legacyHealth?.status === 'rejected') {
    return { ...known, state: 'error', label: 'AI key rejected', detail: `OpenRouter rejected the saved key (HTTP ${legacyHealth.httpStatus ?? 401}). Save a valid key under Providers.` };
  }
  const n = inv.eligible.length + (inv.builtinInUse ? 1 : 0);
  return { ...known, state: 'active', label: 'AI active', detail: `${n} eligible route${n === 1 ? '' : 's'} configured; no request in the last 24 hours, so nothing is confirmed yet.${legacyNote}` };
}
