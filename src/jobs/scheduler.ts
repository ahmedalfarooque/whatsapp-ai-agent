import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { logger } from '../logger';
import { runWithAccount } from '../accounts/accountContext';

/**
 * Durable job schedule (table scheduled_jobs, migration 025). A job is a row: what to run (kind), for which record (ref_kind/ref_id),
 * when (run_at, UTC), identified by a dedupe key so scheduling the same thing twice is a no-op and cancelling a record cancels all of
 * its jobs. Rows survive restarts: the scheduler simply runs whatever is due when the process is up. Handlers are registered by kind;
 * a handler that throws is retried up to MAX_ATTEMPTS with a short delay, then the row is marked failed (visible, never silent).
 *
 * This is deliberately small: one SQLite table and one timer, no external queue, no new paid service.
 */

export interface ScheduledJob {
  id: number;
  whatsapp_account_id: number;
  kind: string;
  ref_kind: string;
  ref_id: number;
  dedupe_key: string;
  run_at: string;
  status: 'pending' | 'running' | 'done' | 'cancelled' | 'failed';
  attempts: number;
  last_error: string | null;
  payload: string | null;
  created_at: string;
  updated_at: string;
  ran_at: string | null;
}

export type JobHandler = (job: ScheduledJob, payload: Record<string, unknown>) => Promise<void> | void;

const handlers = new Map<string, JobHandler>();
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_S = 60;
export const SCHEDULER_TICK_MS = 15_000;

/** SQLite-style UTC timestamp ('YYYY-MM-DD HH:MM:SS'), comparable with datetime('now'). */
export function sqliteTime(at: Date | number): string {
  return new Date(at).toISOString().slice(0, 19).replace('T', ' ');
}

export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}

/** Test hook. */
export function resetJobHandlersForTests(): void {
  handlers.clear();
}

/**
 * Schedules (or re-times) one job. Idempotent by dedupe key: an existing pending job gets the new run_at; a done/cancelled/failed one
 * is left alone unless `reopen` is set (used when a request is rescheduled). Returns the row.
 */
export function scheduleJob(
  input: { accountId: number; kind: string; refKind: string; refId: number; runAt: Date | number; dedupeKey: string; payload?: Record<string, unknown>; reopen?: boolean },
  db: Database.Database = getDb(),
): ScheduledJob {
  const existing = db.prepare('SELECT * FROM scheduled_jobs WHERE dedupe_key = ?').get(input.dedupeKey) as ScheduledJob | undefined;
  const runAt = sqliteTime(input.runAt);
  const payload = input.payload ? JSON.stringify(input.payload) : null;
  if (existing) {
    if (existing.status === 'pending' || input.reopen) {
      db.prepare(`UPDATE scheduled_jobs SET run_at = ?, payload = ?, status = 'pending', attempts = 0, last_error = NULL, updated_at = datetime('now') WHERE id = ?`).run(runAt, payload, existing.id);
    }
    return db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(existing.id) as ScheduledJob;
  }
  const result = db
    .prepare(`INSERT INTO scheduled_jobs (whatsapp_account_id, kind, ref_kind, ref_id, dedupe_key, run_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(input.accountId, input.kind, input.refKind, input.refId, input.dedupeKey, runAt, payload);
  return db.prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(result.lastInsertRowid) as ScheduledJob;
}

/** Cancels every pending job of one record (all kinds, or one kind). Returns how many were cancelled. */
export function cancelJobsFor(refKind: string, refId: number, kind?: string, db: Database.Database = getDb()): number {
  const r = db
    .prepare(`UPDATE scheduled_jobs SET status = 'cancelled', updated_at = datetime('now') WHERE ref_kind = ? AND ref_id = ? AND status = 'pending' ${kind ? 'AND kind = ?' : ''}`)
    .run(...(kind ? [refKind, refId, kind] : [refKind, refId]));
  return r.changes;
}

export function listJobsFor(refKind: string, refId: number, db: Database.Database = getDb()): ScheduledJob[] {
  return db.prepare('SELECT * FROM scheduled_jobs WHERE ref_kind = ? AND ref_id = ? ORDER BY run_at, id').all(refKind, refId) as ScheduledJob[];
}

export function pendingJobs(db: Database.Database = getDb()): ScheduledJob[] {
  return db.prepare(`SELECT * FROM scheduled_jobs WHERE status = 'pending' ORDER BY run_at, id`).all() as ScheduledJob[];
}

let running: Promise<number> | null = null;

/**
 * Runs every job that is due at `now` (serialised: one pass at a time). Each job is claimed (status running) before its handler runs,
 * so a crash mid-way leaves a visible `running` row that the next boot re-queues (recoverStaleJobs). Returns how many ran.
 */
export function runDueJobs(now: Date = new Date(), db: Database.Database = getDb()): Promise<number> {
  if (running) return running;
  let settled = false;
  const pass = (async () => {
    let ran = 0;
    try {
      const due = db.prepare(`SELECT * FROM scheduled_jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT 100`).all(sqliteTime(now)) as ScheduledJob[];
      for (const job of due) {
        const claimed = db.prepare(`UPDATE scheduled_jobs SET status = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ? AND status = 'pending'`).run(job.id);
        if (claimed.changes === 0) continue;
        const handler = handlers.get(job.kind);
        if (!handler) {
          db.prepare(`UPDATE scheduled_jobs SET status = 'failed', last_error = 'no handler registered', updated_at = datetime('now') WHERE id = ?`).run(job.id);
          logger.warn({ id: job.id, kind: job.kind }, '[JOBS] no handler registered');
          continue;
        }
        let payload: Record<string, unknown> = {};
        try { payload = job.payload ? (JSON.parse(job.payload) as Record<string, unknown>) : {}; } catch { payload = {}; }
        try {
          await runWithAccount(job.whatsapp_account_id, () => handler({ ...job, attempts: job.attempts + 1 }, payload));
          db.prepare(`UPDATE scheduled_jobs SET status = 'done', ran_at = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'running'`).run(job.id);
          ran += 1;
        } catch (error) {
          const attempts = job.attempts + 1;
          const message = String((error as Error)?.message ?? error).slice(0, 300);
          const exhausted = attempts >= MAX_ATTEMPTS;
          db.prepare(`UPDATE scheduled_jobs SET status = ?, run_at = ?, last_error = ?, updated_at = datetime('now') WHERE id = ? AND status = 'running'`)
            .run(exhausted ? 'failed' : 'pending', exhausted ? job.run_at : sqliteTime(Date.now() + RETRY_DELAY_S * 1000), message, job.id);
          logger.warn({ id: job.id, kind: job.kind, attempts, exhausted, error: message }, '[JOBS] job failed');
        }
      }
      return ran;
    } finally {
      settled = true;
      running = null;
    }
  })();
  // A pass that finished synchronously (nothing due, or only synchronous handlers) must never linger as the in-flight marker.
  if (!settled) running = pass;
  return pass;
}

/** A job left `running` by a crash is put back in the queue at boot (it is retried, never lost). Returns how many. */
export function recoverStaleJobs(db: Database.Database = getDb()): number {
  return db.prepare(`UPDATE scheduled_jobs SET status = 'pending', updated_at = datetime('now') WHERE status = 'running'`).run().changes;
}

let timer: NodeJS.Timeout | null = null;

/** Starts the in-process tick (idempotent). The first pass runs shortly after boot so due reminders survive a restart. */
export function startScheduler(tickMs: number = SCHEDULER_TICK_MS): void {
  if (timer) return;
  const tick = (): void => { void runDueJobs().catch((error) => logger.warn({ error }, '[JOBS] tick failed')); };
  timer = setInterval(tick, tickMs);
  timer.unref();
  setTimeout(tick, Math.min(tickMs, 5_000)).unref();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
