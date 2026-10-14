import { getDb } from '../memory/db';
import { maskWaId } from '../logger';
import { env } from '../config/env';
import { getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { credentialSavedAtMs, getCachedModelHealth, getCachedProviderHealth } from '../llm/aiProviderHealth';
import { listProvidersForAccount, providerApiKey } from '../llm/providerRepo';
import { hasLocalRoute } from '../llm/aiRouter';
import { getBusinessSettings } from '../config/businessSettings';
import { getAutomationSettings } from '../automation/settingsRepo';
import { runWithAccount } from '../accounts/accountContext';
import { getRecentConversations } from './data';
import { listCustomerVisibleOffers } from '../offers/offerRepo';
import { accountHasFeature, FEATURES } from '../accounts/accountFeatures';
import { customerCatalogues } from '../catalogues/catalogueRepo';
import { effectivePermissions, levelAtLeast, type AuthUser, type FeatureKey } from './permissions';
import type { AccountUiStatus } from '../accounts/accountStatus';

/**
 * Everything the dashboard home shows, computed from the live database for ONE WhatsApp account the signed-in user may open.
 * Each section is included only when the user holds that feature on that account — a section the user cannot read is returned
 * as null, never as zero — and nothing here is fabricated: an unknown value is null and the page says so.
 */

export type OverviewRange = '7' | '30' | '90' | 'all';
export const OVERVIEW_RANGES: readonly OverviewRange[] = ['7', '30', '90', 'all'];

export interface OverviewAccount {
  id: number;
  name: string;
  uiStatus: AccountUiStatus;
  phoneNumber: string | null;
}

const DAY_MS = 86_400_000;
const sqlTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function one(sql: string, ...params: unknown[]): number {
  return (getDb().prepare(sql).get(...params) as { n: number }).n;
}

/** Percentage change against the previous period of the same length; null when there is nothing to compare against. */
function change(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export interface AiState {
  state: 'active' | 'off' | 'needs_key' | 'error' | 'mock';
  label: string;
  detail: string;
  /** True only when the provider itself confirmed the saved key (a live check or a real reply), not merely that a key is saved. */
  verified: boolean;
  /** The model this account is configured to use (never a secret), or null when no real AI is involved. */
  model: string | null;
  /** True only when that model has actually answered (a live probe or a real reply): a valid key alone does not prove it. */
  modelVerified: boolean;
}

const dbTimeMs = (value: string): number => Date.parse(`${value.replace(' ', 'T')}Z`);

/**
 * The REAL state of AI replies for one account. Three separate pieces of evidence, newest wins:
 *  - the KEY: a live, cached check with the provider (llm/aiProviderHealth);
 *  - the MODEL: a tiny cached probe of the account's configured model (a valid key does not make a blocked, rate-limited or
 *    empty-answering model usable);
 *  - REAL replies: the latest AI reply of this account — a success (non-empty answer) or a failure.
 * Failures recorded before the key was last saved, or under a different model, are ignored, so correcting the key or the model clears
 * the warning. "No recent failures" never counts as proof the AI works.
 */
export function getAiState(accountId: number, now: number = Date.now()): AiState {
  const settings = runWithAccount(accountId, () => getAutomationSettings()); // this account's switches, whatever account the request context holds
  const base = { verified: false, model: null, modelVerified: false };
  if (env.shouldUseMockProviders) return { ...base, state: 'mock', label: 'Test mode', detail: 'Mock providers: no real AI calls are made' };
  if (!settings.autoRepliesEnabled || !settings.aiRepliesEnabled) return { ...base, state: 'off', label: 'AI off', detail: 'Free-text AI replies are switched off for this account' };
  // The built-in OpenRouter key is one route among the configured providers and the local route: "needs a key" only when none exists.
  const otherRoutes = listProvidersForAccount(accountId).some((p) => p.enabled !== 0 && (p.kind === 'ollama' || providerApiKey(p))) || hasLocalRoute(accountId);
  if (!isUsableApiKey(getEffectiveCredential('OPENROUTER_API_KEY')) && !otherRoutes) return { ...base, state: 'needs_key', label: 'AI needs a key', detail: 'No usable AI provider key is saved' };

  const model = runWithAccount(accountId, () => getBusinessSettings(accountId).openRouterModel);
  const known = { ...base, model };
  const key = getCachedProviderHealth(now);
  if (key?.status === 'rejected') {
    return { ...known, state: 'error', label: 'AI key rejected', detail: `OpenRouter rejected the saved key (HTTP ${key.httpStatus}). Save a valid key under Providers` };
  }
  if (key?.status === 'rate_limited') {
    return { ...known, state: 'error', label: 'AI provider busy', detail: 'OpenRouter is rate limiting this key; AI replies may fail until it recovers' };
  }
  const keyVerified = key?.status === 'ok';

  // Real replies since the later of "24 hours ago" and "the key was last saved".
  const savedAt = credentialSavedAtMs();
  const windowStart = sqlTime(Math.max(now - DAY_MS, savedAt ?? 0));
  const db = getDb();
  const failure = db
    .prepare(
      `SELECT created_at AS at, detail FROM reply_activity
       WHERE whatsapp_account_id = ? AND kind = 'error' AND created_at >= ?
         AND (detail LIKE 'AI credential problem%' OR (detail LIKE 'AI failed%' AND instr(detail, ?) > 0))
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(accountId, windowStart, `model ${model}`) as { at: string; detail: string } | undefined;
  const success = db
    .prepare("SELECT MAX(created_at) AS at FROM reply_activity WHERE whatsapp_account_id = ? AND kind = 'ai' AND created_at >= ?")
    .get(accountId, windowStart) as { at: string | null };
  const okMs = success.at ? dbTimeMs(success.at) : null;

  if (failure && (!success.at || failure.at > success.at)) {
    if (failure.detail.startsWith('AI credential problem') && !keyVerified) {
      return { ...known, state: 'error', label: 'AI key rejected', detail: 'The AI provider rejected the saved key since it was last saved' };
    }
    if (/HTTP 402|credits exhausted/i.test(failure.detail)) {
      return { ...known, verified: keyVerified, state: 'error', label: 'AI credits exhausted', detail: 'OpenRouter answered HTTP 402 (credit exhausted or too low for the prompt): top up credits at openrouter.ai/settings/credits; customers receive the fallback message until then' };
    }
    const why = /\(([^)]*)\)/.exec(failure.detail)?.[1];
    return { ...known, verified: keyVerified, state: 'error', label: 'AI replies failing', detail: `The latest AI reply failed${why ? ` (${why})` : ''}; the customer received the fallback message` };
  }

  const probe = getCachedModelHealth(model, now);
  if (probe && probe.status !== 'usable' && (okMs === null || probe.checkedAt > okMs)) {
    const reason = { empty: 'returned an empty answer', unavailable: `was refused (HTTP ${probe.httpStatus}): check the model name and the OpenRouter data-policy settings`, rate_limited: 'is being rate limited', error: 'could not be reached' }[probe.status];
    return { ...known, verified: keyVerified, state: 'error', label: 'AI model unavailable', detail: `The key is valid but model ${model} ${reason}` };
  }
  if (okMs !== null) {
    return { ...known, verified: true, modelVerified: true, state: 'active', label: 'AI active', detail: `Last AI reply with ${model} succeeded at ${new Date(okMs).toISOString().slice(11, 16)} UTC` };
  }
  if (probe?.status === 'usable') {
    return { ...known, verified: true, modelVerified: true, state: 'active', label: 'AI active', detail: `Key and model ${model} verified at ${new Date(probe.checkedAt).toISOString().slice(11, 16)} UTC` };
  }
  if (keyVerified) {
    return { ...known, verified: true, state: 'active', label: 'AI active', detail: `Key verified; model ${model} not confirmed yet` };
  }
  return { ...known, state: 'active', label: 'AI active', detail: 'A key is saved; it could not be verified with OpenRouter just now' };
}

export interface ActivityWindow {
  replies: number;
  ai: number;
  menu: number;
  handoff: number;
  attention: number;
}

function activityWindow(accountId: number, fromMs: number, toMs: number): ActivityWindow {
  const rows = getDb()
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM reply_activity
       WHERE whatsapp_account_id = ? AND created_at >= ? AND created_at < ? GROUP BY kind`,
    )
    .all(accountId, sqlTime(fromMs), sqlTime(toMs)) as { kind: string; n: number }[];
  const by = Object.fromEntries(rows.map((r) => [r.kind, r.n])) as Record<string, number>;
  const ai = by.ai ?? 0;
  const menu = by.rule ?? 0;
  const handoff = by.human_handoff ?? 0;
  return { replies: ai + menu + handoff, ai, menu, handoff, attention: by.error ?? 0 };
}

export function buildOverview(params: {
  user: AuthUser;
  accountId: number;
  accountName: string;
  accounts: OverviewAccount[];
  range: OverviewRange;
  now?: number;
}) {
  const { user, accountId, accounts } = params;
  const now = params.now ?? Date.now();
  const days = params.range === 'all' ? null : Number.parseInt(params.range, 10);
  const since = days === null ? null : now - days * DAY_MS;
  const previousSince = days === null || since === null ? null : since - days * DAY_MS;
  const perms = effectivePermissions(user, accountId);
  const can = (feature: FeatureKey): boolean => levelAtLeast(perms[feature], 'view');
  const sinceSql = since === null ? '0000-00-00 00:00:00' : sqlTime(since);
  const prevFromSql = previousSince === null ? null : sqlTime(previousSince);

  const connected = accounts.filter((a) => a.uiStatus === 'connected').length;
  const needAttention = accounts.filter((a) => a.uiStatus !== 'connected' && a.uiStatus !== 'disabled');

  // ---- conversations
  let conversations: { count: number; previous: number | null; change: number | null; total: number; active: number } | null = null;
  let recentConversations: ReturnType<typeof getRecentConversations> | null = null;
  if (can('conversations')) {
    const count = one('SELECT COUNT(*) AS n FROM conversations WHERE whatsapp_account_id = ? AND started_at >= ?', accountId, sinceSql);
    const previous = prevFromSql === null ? null : one('SELECT COUNT(*) AS n FROM conversations WHERE whatsapp_account_id = ? AND started_at >= ? AND started_at < ?', accountId, prevFromSql, sinceSql);
    conversations = {
      count,
      previous,
      change: change(count, previous),
      total: one('SELECT COUNT(*) AS n FROM conversations WHERE whatsapp_account_id = ?', accountId),
      active: one("SELECT COUNT(*) AS n FROM conversations WHERE whatsapp_account_id = ? AND status = 'active'", accountId),
    };
    recentConversations = getRecentConversations(6, accountId);
  }

  // ---- customer requests
  let requests: {
    count: number; previous: number | null; change: number | null; pending: number;
    recent: Array<{ id: number; reference: string; kind: string; status: string; customer: string; createdAt: string }>;
  } | null = null;
  if (can('requests')) {
    const count = one('SELECT COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id = ? AND created_at >= ?', accountId, sinceSql);
    const previous = prevFromSql === null ? null : one('SELECT COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id = ? AND created_at >= ? AND created_at < ?', accountId, prevFromSql, sinceSql);
    const recent = getDb()
      .prepare(
        `SELECT r.id, r.reference, r.kind, r.status, r.created_at, r.wa_id, c.display_name
         FROM customer_requests r LEFT JOIN customers c ON c.id = r.customer_id
         WHERE r.whatsapp_account_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 6`,
      )
      .all(accountId) as Array<{ id: number; reference: string; kind: string; status: string; created_at: string; wa_id: string; display_name: string | null }>;
    requests = {
      count,
      previous,
      change: change(count, previous),
      pending: one("SELECT COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id = ? AND status = 'pending'", accountId),
      recent: recent.map((r) => ({ id: r.id, reference: r.reference, kind: r.kind, status: r.status, customer: r.display_name || maskWaId(r.wa_id), createdAt: r.created_at })),
    };
  }

  // ---- offers & catalogues
  let offers: { active: number; views: number; catalogues: number | null } | null = null;
  if (can('offers')) {
    offers = {
      active: listCustomerVisibleOffers(new Date(now), undefined, accountId).length,
      views: one("SELECT COUNT(*) AS n FROM reply_activity WHERE whatsapp_account_id = ? AND template_key = 'prices_offers_list' AND created_at >= ?", accountId, sinceSql),
      catalogues: can('catalogues') && accountHasFeature(accountId, FEATURES.CATALOGUES) ? customerCatalogues().length : null,
    };
  }

  // ---- AI & automation
  let automation: {
    ai: AiState; autoReplies: boolean; aiReplies: boolean; ruleReplies: boolean;
    aiCount: number; aiPrevious: number | null; aiChange: number | null; menuCount: number; handoffs: number; errors: number;
    pausedCustomers: number;
  } | null = null;
  if (can('dashboard')) {
    const settings = getAutomationSettings();
    const aiCount = one("SELECT COUNT(*) AS n FROM reply_activity WHERE whatsapp_account_id = ? AND kind = 'ai' AND created_at >= ?", accountId, sinceSql);
    const aiPrevious = prevFromSql === null ? null : one("SELECT COUNT(*) AS n FROM reply_activity WHERE whatsapp_account_id = ? AND kind = 'ai' AND created_at >= ? AND created_at < ?", accountId, prevFromSql, sinceSql);
    automation = {
      ai: getAiState(accountId),
      autoReplies: settings.autoRepliesEnabled,
      aiReplies: settings.aiRepliesEnabled,
      ruleReplies: settings.ruleRepliesEnabled,
      aiCount,
      aiPrevious,
      aiChange: change(aiCount, aiPrevious),
      menuCount: one("SELECT COUNT(*) AS n FROM reply_activity WHERE whatsapp_account_id = ? AND kind = 'rule' AND created_at >= ?", accountId, sinceSql),
      handoffs: one("SELECT COUNT(*) AS n FROM reply_activity WHERE whatsapp_account_id = ? AND kind = 'human_handoff' AND created_at >= ?", accountId, sinceSql),
      errors: one("SELECT COUNT(*) AS n FROM reply_activity WHERE whatsapp_account_id = ? AND kind = 'error' AND created_at >= ?", accountId, sinceSql),
      pausedCustomers: one('SELECT COUNT(*) AS n FROM customers WHERE whatsapp_account_id = ? AND automation_paused = 1', accountId),
    };
  }

  // ---- activity log (the three tabs of the Activity panel)
  let activity: {
    windows: { yesterday: ActivityWindow; today: ActivityWindow; weekly: ActivityWindow };
    recent: Array<{ id: number; kind: string; templateKey: string | null; detail: string | null; createdAt: string }>;
  } | null = null;
  if (can('activity')) {
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const today0 = dayStart.getTime();
    const recent = getDb()
      .prepare('SELECT id, kind, template_key, detail, created_at FROM reply_activity WHERE whatsapp_account_id = ? ORDER BY id DESC LIMIT 8')
      .all(accountId) as Array<{ id: number; kind: string; template_key: string | null; detail: string | null; created_at: string }>;
    activity = {
      windows: {
        yesterday: activityWindow(accountId, today0 - DAY_MS, today0),
        today: activityWindow(accountId, today0, now + 1000),
        weekly: activityWindow(accountId, now - 7 * DAY_MS, now + 1000),
      },
      recent: recent.map((r) => ({ id: r.id, kind: r.kind, templateKey: r.template_key, detail: r.detail, createdAt: r.created_at })),
    };
  }

  return {
    generatedAt: new Date(now).toISOString(),
    range: params.range,
    account: { id: accountId, name: params.accountName },
    permissions: perms,
    accounts: { total: accounts.length, connected, items: accounts, needAttention: needAttention.map((a) => ({ id: a.id, name: a.name, status: a.uiStatus })) },
    conversations,
    recentConversations,
    requests,
    offers,
    automation,
    activity,
  };
}
