import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { parseDraftContent, type DraftContent } from './types';
import { refreshDerivedReplies } from './menuGenerator';
import { LEGACY_ACCOUNT_ID } from '../accounts/accountContext';

/** Stored "Analyze & Generate" drafts — always scoped to one account. */

export type DraftStatus = 'draft' | 'applied' | 'discarded';

export interface ApplyReportEntry {
  section: 'profile' | 'knowledge' | 'offers' | 'templates' | 'menu';
  action: 'applied' | 'staged' | 'kept' | 'skipped' | 'error';
  detail: string;
}

export interface ApplyReport {
  mode: 'save_draft' | 'merge' | 'replace';
  entries: ApplyReportEntry[];
  backups: string[];
  knowledgeChanged: boolean;
}

export interface SetupDraft {
  id: number;
  accountId: number;
  status: DraftStatus;
  generator: 'rules' | 'ai';
  model: string | null;
  sources: Record<string, unknown>;
  content: DraftContent;
  warnings: string[];
  apply: ApplyReport | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
}

interface Row {
  id: number;
  whatsapp_account_id: number;
  status: string;
  generator: string;
  model: string | null;
  sources_json: string;
  content_json: string;
  warnings_json: string;
  apply_json: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  applied_at: string | null;
}

function toDraft(r: Row): SetupDraft {
  return {
    id: r.id,
    accountId: r.whatsapp_account_id,
    status: r.status as DraftStatus,
    generator: r.generator === 'ai' ? 'ai' : 'rules',
    model: r.model,
    sources: JSON.parse(r.sources_json) as Record<string, unknown>,
    content: parseDraftContent(JSON.parse(r.content_json)),
    warnings: JSON.parse(r.warnings_json) as string[],
    apply: r.apply_json ? (JSON.parse(r.apply_json) as ApplyReport) : null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    appliedAt: r.applied_at,
  };
}

export function createDraft(
  input: { content: DraftContent; generator: 'rules' | 'ai'; model: string | null; sources: Record<string, unknown>; warnings: string[]; createdBy: string },
  accountId: number = currentAccountId(),
  db: Database.Database = getDb(),
): SetupDraft {
  const content = parseDraftContent(input.content); // never store something the editor could not load back
  const result = db
    .prepare(
      `INSERT INTO setup_drafts (whatsapp_account_id, generator, model, sources_json, content_json, warnings_json, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(accountId, input.generator, input.model, JSON.stringify(input.sources), JSON.stringify(content), JSON.stringify(input.warnings), input.createdBy);
  return getDraft(Number(result.lastInsertRowid), accountId, db)!;
}

export function getDraft(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): SetupDraft | undefined {
  const row = db.prepare('SELECT * FROM setup_drafts WHERE id = ? AND whatsapp_account_id = ?').get(id, accountId) as Row | undefined;
  return row ? toDraft(row) : undefined;
}

/** The newest draft that is still open, else the newest applied one (so the page can show what was last done). */
export function latestDraft(accountId: number = currentAccountId(), db: Database.Database = getDb()): SetupDraft | undefined {
  const open = db.prepare("SELECT * FROM setup_drafts WHERE whatsapp_account_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1").get(accountId) as Row | undefined;
  if (open) return toDraft(open);
  const any = db.prepare("SELECT * FROM setup_drafts WHERE whatsapp_account_id = ? AND status <> 'discarded' ORDER BY id DESC LIMIT 1").get(accountId) as Row | undefined;
  return any ? toDraft(any) : undefined;
}

export function listDraftSummaries(accountId: number = currentAccountId(), limit = 10, db: Database.Database = getDb()): { id: number; status: DraftStatus; generator: string; createdAt: string; appliedAt: string | null }[] {
  return (db.prepare('SELECT id, status, generator, created_at, applied_at FROM setup_drafts WHERE whatsapp_account_id = ? ORDER BY id DESC LIMIT ?').all(accountId, limit) as { id: number; status: DraftStatus; generator: string; created_at: string; applied_at: string | null }[]).map((r) => ({
    id: r.id, status: r.status, generator: r.generator, createdAt: r.created_at, appliedAt: r.applied_at,
  }));
}

export function updateDraftContent(id: number, content: unknown, accountId: number = currentAccountId(), db: Database.Database = getDb()): SetupDraft | undefined {
  const current = getDraft(id, accountId, db);
  if (!current) return undefined;
  if (current.status !== 'draft') throw new DraftStateError('This draft was already applied or discarded. Analyze again to start a new one.');
  const incoming = parseDraftContent(content);
  // The original business has no generated replies; for every other business the replies derived from the content follow the edit.
  const parsed = accountId === LEGACY_ACCOUNT_ID ? incoming : refreshDerivedReplies(incoming, current.content);
  db.prepare("UPDATE setup_drafts SET content_json = ?, updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ?").run(JSON.stringify(parsed), id, accountId);
  return getDraft(id, accountId, db);
}

export function discardDraft(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): boolean {
  return db.prepare("UPDATE setup_drafts SET status = 'discarded', updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ? AND status = 'draft'").run(id, accountId).changes > 0;
}

export function markApplied(id: number, report: ApplyReport, accountId: number = currentAccountId(), db: Database.Database = getDb()): void {
  db.prepare("UPDATE setup_drafts SET status = 'applied', apply_json = ?, applied_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ?").run(JSON.stringify(report), id, accountId);
}

export function recordStaged(id: number, report: ApplyReport, accountId: number = currentAccountId(), db: Database.Database = getDb()): void {
  db.prepare("UPDATE setup_drafts SET apply_json = ?, updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ?").run(JSON.stringify(report), id, accountId);
}

export class DraftStateError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
  }
}
