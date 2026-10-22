import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { accountHasFeature, FEATURES } from '../accounts/accountFeatures';
import type { SkillDefinition } from './skillFile';

/**
 * What each business decided about each skill, and the audit trail. Everything is keyed by the business (WhatsApp account), the tenant boundary of this
 * application: a business can only ever read or change its OWN rows (the account id comes from the authenticated dashboard session or the inbound message,
 * never from a request field). Precedence: the business's own choice, else the skill's `default_enabled`, else off.
 */
export interface SkillState { enabled: boolean; explicit: boolean; updatedAt: string | null; updatedBy: number | null }

export function skillStates(accountId: number, db: Database.Database = getDb()): Map<string, SkillState> {
  const out = new Map<string, SkillState>();
  for (const row of db.prepare('SELECT skill_id, enabled, updated_at, updated_by FROM account_skills WHERE whatsapp_account_id = ?').all(accountId) as Array<{ skill_id: string; enabled: number; updated_at: string; updated_by: number | null }>) {
    out.set(row.skill_id, { enabled: row.enabled === 1, explicit: true, updatedAt: row.updated_at, updatedBy: row.updated_by });
  }
  return out;
}

export function stateOf(skill: SkillDefinition, states: Map<string, SkillState>): SkillState {
  return states.get(skill.id) ?? { enabled: skill.defaultEnabled, explicit: false, updatedAt: null, updatedBy: null };
}

/** Whether this business has the add-on the skill needs. */
export function skillAvailableTo(accountId: number, skill: SkillDefinition, db: Database.Database = getDb()): boolean {
  if (!skill.requiresFeature) return true;
  return accountHasFeature(accountId, skill.requiresFeature === 'catalogues' ? FEATURES.CATALOGUES : FEATURES.REAL_ESTATE, db);
}

export function setSkillEnabled(accountId: number, skillId: string, enabled: boolean, updatedBy: number | null, db: Database.Database = getDb()): void {
  db.prepare(`INSERT INTO account_skills (whatsapp_account_id, skill_id, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
              ON CONFLICT (whatsapp_account_id, skill_id) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(accountId, skillId, enabled ? 1 : 0, updatedBy);
}

export type SkillRunStatus = 'started' | 'answered' | 'failed';
export interface SkillRunRow { id: number; skill_id: string; conversation_id: number | null; selection: string; status: SkillRunStatus; tools_used: string; reason: string | null; created_at: string; finished_at: string | null }

export function startSkillRun(accountId: number, skillId: string, conversationId: number | null, selection: 'explicit' | 'automatic', db: Database.Database = getDb()): number {
  return Number(db.prepare('INSERT INTO skill_runs (whatsapp_account_id, skill_id, conversation_id, selection) VALUES (?, ?, ?, ?)').run(accountId, skillId, conversationId, selection).lastInsertRowid);
}

/** `reason` is a short code ("tool_rounds_exhausted"), never an error message, a prompt or customer text. */
export function finishSkillRun(accountId: number, runId: number, status: Exclude<SkillRunStatus, 'started'>, toolsUsed: string[], reason: string | null, db: Database.Database = getDb()): void {
  db.prepare("UPDATE skill_runs SET status = ?, tools_used = ?, reason = ?, finished_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ?")
    .run(status, [...new Set(toolsUsed)].join(',').slice(0, 300), reason ? reason.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 60) : null, runId, accountId);
}

export function listSkillRuns(accountId: number, skillId: string | null, limit = 20, db: Database.Database = getDb()): SkillRunRow[] {
  const cap = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  return skillId
    ? db.prepare('SELECT id, skill_id, conversation_id, selection, status, tools_used, reason, created_at, finished_at FROM skill_runs WHERE whatsapp_account_id = ? AND skill_id = ? ORDER BY id DESC LIMIT ?').all(accountId, skillId, cap) as SkillRunRow[]
    : db.prepare('SELECT id, skill_id, conversation_id, selection, status, tools_used, reason, created_at, finished_at FROM skill_runs WHERE whatsapp_account_id = ? ORDER BY id DESC LIMIT ?').all(accountId, cap) as SkillRunRow[];
}

export function skillRunCounts(accountId: number, db: Database.Database = getDb()): Map<string, { total: number; answered: number; failed: number; last: string | null }> {
  const out = new Map<string, { total: number; answered: number; failed: number; last: string | null }>();
  for (const r of db.prepare("SELECT skill_id, COUNT(*) AS total, SUM(status = 'answered') AS answered, SUM(status = 'failed') AS failed, MAX(created_at) AS last FROM skill_runs WHERE whatsapp_account_id = ? GROUP BY skill_id").all(accountId) as Array<{ skill_id: string; total: number; answered: number | null; failed: number | null; last: string | null }>) {
    out.set(r.skill_id, { total: r.total, answered: r.answered ?? 0, failed: r.failed ?? 0, last: r.last });
  }
  return out;
}
