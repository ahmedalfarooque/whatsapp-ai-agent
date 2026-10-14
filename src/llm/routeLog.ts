import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';

/**
 * ai_route_log (migration 027): one row per AI route attempt. Read by the dashboard (routing history, success/failure/latency charts)
 * and by the overview. Never stores a prompt, a key or customer text — only which provider/model was tried, the outcome, a category,
 * the HTTP status, the latency and the provider's short message.
 */
export type RouteOutcome = 'ok' | 'failed' | 'skipped';

export interface RouteLogInput {
  accountId: number;
  task: string;
  providerId: number | null;
  providerName: string;
  model: string;
  outcome: RouteOutcome;
  category?: string | null;
  httpStatus?: number | null;
  latencyMs: number;
  detail?: string | null;
}

export interface RouteLogRow {
  id: number;
  whatsapp_account_id: number;
  task: string;
  provider_id: number | null;
  provider_name: string;
  model: string;
  outcome: RouteOutcome;
  category: string | null;
  http_status: number | null;
  latency_ms: number;
  detail: string | null;
  created_at: string;
}

const KEEP_DAYS = 14;
let lastPruneAt = 0;

export function recordRouteAttempt(input: RouteLogInput, db: Database.Database = getDb()): void {
  try {
    db.prepare(`INSERT INTO ai_route_log (whatsapp_account_id, task, provider_id, provider_name, model, outcome, category, http_status, latency_ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.accountId, input.task, input.providerId, input.providerName.slice(0, 80), input.model.slice(0, 120), input.outcome, input.category ?? null, input.httpStatus ?? null, Math.max(0, Math.round(input.latencyMs)), input.detail ? input.detail.slice(0, 200) : null);
    const now = Date.now();
    if (now - lastPruneAt > 60 * 60_000) {
      lastPruneAt = now;
      db.prepare(`DELETE FROM ai_route_log WHERE created_at < datetime('now', ?)`).run(`-${KEEP_DAYS} days`);
    }
  } catch {
    // the log must never break a reply
  }
}

export function listRouteLog(accountId: number, limit = 50, db: Database.Database = getDb()): RouteLogRow[] {
  return db.prepare('SELECT * FROM ai_route_log WHERE whatsapp_account_id = ? ORDER BY id DESC LIMIT ?').all(accountId, Math.min(Math.max(1, limit), 500)) as RouteLogRow[];
}

export interface RouteStats {
  perRoute: Array<{ providerName: string; model: string; ok: number; failed: number; avgLatencyMs: number | null; lastOutcome: RouteOutcome | null; lastCategory: string | null; lastAt: string | null }>;
  hourly: Array<{ hour: string; ok: number; failed: number; avgLatencyMs: number | null }>;
  totals: { ok: number; failed: number; avgLatencyMs: number | null };
}

/** Real numbers for the dashboard charts: per route and per hour over the last `hours` hours (this account only). */
export function routeStats(accountId: number, hours = 24, db: Database.Database = getDb()): RouteStats {
  const since = `-${Math.min(Math.max(1, hours), 24 * 14)} hours`;
  const perRoute = db.prepare(
    `SELECT provider_name AS providerName, model,
            SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
            AVG(CASE WHEN outcome = 'ok' THEN latency_ms END) AS avgLatencyMs, MAX(created_at) AS lastAt
     FROM ai_route_log WHERE whatsapp_account_id = ? AND outcome IN ('ok', 'failed') AND created_at >= datetime('now', ?)
     GROUP BY provider_name, model ORDER BY ok DESC, failed DESC`,
  ).all(accountId, since) as Array<{ providerName: string; model: string; ok: number; failed: number; avgLatencyMs: number | null; lastAt: string | null }>;
  const last = db.prepare(`SELECT provider_name, model, outcome, category FROM ai_route_log WHERE whatsapp_account_id = ? AND outcome IN ('ok','failed') AND created_at >= datetime('now', ?) ORDER BY id DESC`).all(accountId, since) as Array<{ provider_name: string; model: string; outcome: RouteOutcome; category: string | null }>;
  const lastBy = new Map<string, { outcome: RouteOutcome; category: string | null }>();
  for (const r of last) { const k = `${r.provider_name}\n${r.model}`; if (!lastBy.has(k)) lastBy.set(k, { outcome: r.outcome, category: r.category }); }
  const hourly = db.prepare(
    `SELECT strftime('%Y-%m-%dT%H:00Z', created_at) AS hour, SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed, AVG(CASE WHEN outcome = 'ok' THEN latency_ms END) AS avgLatencyMs
     FROM ai_route_log WHERE whatsapp_account_id = ? AND outcome IN ('ok','failed') AND created_at >= datetime('now', ?) GROUP BY hour ORDER BY hour`,
  ).all(accountId, since) as RouteStats['hourly'];
  const totals = db.prepare(`SELECT SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed, AVG(CASE WHEN outcome = 'ok' THEN latency_ms END) AS avgLatencyMs FROM ai_route_log WHERE whatsapp_account_id = ? AND outcome IN ('ok','failed') AND created_at >= datetime('now', ?)`).get(accountId, since) as { ok: number | null; failed: number | null; avgLatencyMs: number | null };
  return {
    perRoute: perRoute.map((r) => ({ ...r, avgLatencyMs: r.avgLatencyMs === null ? null : Math.round(r.avgLatencyMs), lastOutcome: lastBy.get(`${r.providerName}\n${r.model}`)?.outcome ?? null, lastCategory: lastBy.get(`${r.providerName}\n${r.model}`)?.category ?? null })),
    hourly: hourly.map((h) => ({ ...h, avgLatencyMs: h.avgLatencyMs === null ? null : Math.round(h.avgLatencyMs) })),
    totals: { ok: totals.ok ?? 0, failed: totals.failed ?? 0, avgLatencyMs: totals.avgLatencyMs === null ? null : Math.round(totals.avgLatencyMs) },
  };
}
