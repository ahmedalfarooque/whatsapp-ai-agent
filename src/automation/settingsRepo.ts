import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';

export interface AutomationSettings {
  autoRepliesEnabled: boolean;
  ruleRepliesEnabled: boolean;
  aiRepliesEnabled: boolean;
  updatedAt: string;
}

interface SettingsRow {
  auto_replies_enabled: number;
  rule_replies_enabled: number;
  ai_replies_enabled: number;
  updated_at: string;
}

/** automation_settings.id == whatsapp account id (one row per business). */
export function getAutomationSettings(db: Database.Database = getDb(), accountId: number = currentAccountId()): AutomationSettings {
  let row = db.prepare('SELECT * FROM automation_settings WHERE id = ?').get(accountId) as SettingsRow | undefined;
  if (!row && db.prepare('SELECT 1 FROM whatsapp_accounts WHERE id = ?').get(accountId)) {
    db.prepare('INSERT OR IGNORE INTO automation_settings (id) VALUES (?)').run(accountId);
    row = db.prepare('SELECT * FROM automation_settings WHERE id = ?').get(accountId) as SettingsRow | undefined;
  }
  if (!row) throw new Error(`automation_settings row for account ${accountId} is missing — unknown account or migrations did not run correctly`);
  return {
    autoRepliesEnabled: row.auto_replies_enabled === 1,
    ruleRepliesEnabled: row.rule_replies_enabled === 1,
    aiRepliesEnabled: row.ai_replies_enabled === 1,
    updatedAt: row.updated_at,
  };
}

export function updateAutomationSettings(
  patch: Partial<Pick<AutomationSettings, 'autoRepliesEnabled' | 'ruleRepliesEnabled' | 'aiRepliesEnabled'>>,
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): AutomationSettings {
  const current = getAutomationSettings(db, accountId);
  const next = { ...current, ...patch };
  db.prepare(
    `UPDATE automation_settings
     SET auto_replies_enabled = @auto, rule_replies_enabled = @rule, ai_replies_enabled = @ai, updated_at = datetime('now')
     WHERE id = @id`,
  ).run({
    id: accountId,
    auto: next.autoRepliesEnabled ? 1 : 0,
    rule: next.ruleRepliesEnabled ? 1 : 0,
    ai: next.aiRepliesEnabled ? 1 : 0,
  });
  return getAutomationSettings(db, accountId);
}

export type ReplyActivityKind = 'rule' | 'ai' | 'human_handoff' | 'suppressed' | 'error';

export interface ReplyActivityEntry {
  id: number;
  customerId: number | null;
  waId: string | null;
  channel: string;
  kind: ReplyActivityKind;
  templateKey: string | null;
  detail: string | null;
  createdAt: string;
}

export function recordReplyActivity(
  entry: {
    customerId?: number;
    waId?: string;
    channel: string;
    kind: ReplyActivityKind;
    templateKey?: string;
    detail?: string;
    accountId?: number;
  },
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `INSERT INTO reply_activity (customer_id, wa_id, channel, kind, template_key, detail, whatsapp_account_id)
     VALUES (@customerId, @waId, @channel, @kind, @templateKey, @detail, @accountId)`,
  ).run({
    customerId: entry.customerId ?? null,
    waId: entry.waId ?? null,
    channel: entry.channel,
    kind: entry.kind,
    templateKey: entry.templateKey ?? null,
    detail: entry.detail ?? null,
    accountId: entry.accountId ?? currentAccountId(),
  });
}

export function listReplyActivity(
  params: { limit?: number; kind?: ReplyActivityKind; accountId?: number } = {},
  db: Database.Database = getDb(),
): ReplyActivityEntry[] {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  const accountId = params.accountId ?? currentAccountId();
  const rows = db
    .prepare(
      `SELECT id, customer_id, wa_id, channel, kind, template_key, detail, created_at
       FROM reply_activity
       WHERE whatsapp_account_id = @accountId ${params.kind ? 'AND kind = @kind' : ''}
       ORDER BY id DESC LIMIT @limit`,
    )
    .all({ limit, kind: params.kind, accountId }) as Array<{
    id: number; customer_id: number | null; wa_id: string | null; channel: string; kind: ReplyActivityKind;
    template_key: string | null; detail: string | null; created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    waId: r.wa_id,
    channel: r.channel,
    kind: r.kind,
    templateKey: r.template_key,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}
