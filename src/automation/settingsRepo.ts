import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';

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

export function getAutomationSettings(db: Database.Database = getDb()): AutomationSettings {
  const row = db.prepare('SELECT * FROM automation_settings WHERE id = 1').get() as SettingsRow | undefined;
  if (!row) throw new Error('automation_settings row (id=1) is missing — migrations did not run correctly');
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
): AutomationSettings {
  const current = getAutomationSettings(db);
  const next = { ...current, ...patch };
  db.prepare(
    `UPDATE automation_settings
     SET auto_replies_enabled = @auto, rule_replies_enabled = @rule, ai_replies_enabled = @ai, updated_at = datetime('now')
     WHERE id = 1`,
  ).run({
    auto: next.autoRepliesEnabled ? 1 : 0,
    rule: next.ruleRepliesEnabled ? 1 : 0,
    ai: next.aiRepliesEnabled ? 1 : 0,
  });
  return getAutomationSettings(db);
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
  },
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `INSERT INTO reply_activity (customer_id, wa_id, channel, kind, template_key, detail)
     VALUES (@customerId, @waId, @channel, @kind, @templateKey, @detail)`,
  ).run({
    customerId: entry.customerId ?? null,
    waId: entry.waId ?? null,
    channel: entry.channel,
    kind: entry.kind,
    templateKey: entry.templateKey ?? null,
    detail: entry.detail ?? null,
  });
}

export function listReplyActivity(
  params: { limit?: number; kind?: ReplyActivityKind } = {},
  db: Database.Database = getDb(),
): ReplyActivityEntry[] {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  const rows = db
    .prepare(
      `SELECT id, customer_id, wa_id, channel, kind, template_key, detail, created_at
       FROM reply_activity
       ${params.kind ? 'WHERE kind = @kind' : ''}
       ORDER BY id DESC LIMIT @limit`,
    )
    .all({ limit, kind: params.kind }) as Array<{
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
