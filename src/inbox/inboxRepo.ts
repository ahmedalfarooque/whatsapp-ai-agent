import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { maskWaId } from '../logger';
import { normalizeNumerals } from '../whatsapp/jid';

/**
 * The unified inbox: one row per customer of ONE WhatsApp account, whatever is handling the conversation (the assistant, waiting for
 * staff, a staff member, resolved). It only READS the existing conversations, customers and human_handoffs tables — nothing is copied
 * or duplicated — and every query is scoped to the account by the caller's context, never by anything the browser sends.
 *
 * What the data supports, and what it does not:
 *  - "needs reply" = the customer's message is the latest in the thread. There is no per-staff read marker in the data model, so this
 *    is NOT an unread count and is never presented as one.
 *  - Delivery: a staff reply is "sent" (accepted by the WhatsApp connection); WhatsApp delivered/read receipts are not stored, so none
 *    is ever shown. Automatic and AI replies carry no status at all.
 */

export type HandlingFilter = 'all' | 'waiting' | 'in_progress' | 'ai' | 'resolved' | 'needs_reply';
export const HANDLING_FILTERS: readonly HandlingFilter[] = ['all', 'waiting', 'in_progress', 'ai', 'resolved', 'needs_reply'];
export type InboxSort = 'recent' | 'waiting_first';
export type AssigneeFilter = 'me' | 'unassigned' | number;

export const MAX_PAGE = 100;
export const DEFAULT_PAGE = 25;
export const MAX_THREAD_PAGE = 200;
export const DEFAULT_THREAD_PAGE = 50;
const PREVIEW_CHARS = 140;

// Only real conversation bubbles: not the tool trail the assistant records while it works.
const VISIBLE = `m.role IN ('user', 'assistant') AND m.content NOT LIKE '[requested tools:%'`;

export interface InboxQuery {
  q?: string;
  handling?: HandlingFilter;
  assignee?: AssigneeFilter;
  sort?: InboxSort;
  limit?: number;
  offset?: number;
  /** The signed-in staff member (for assignee=me). */
  viewerAdminId: number;
}

export interface InboxItem {
  customerId: number;
  name: string | null;
  /** Always masked here; the full number is added by the route only for users who may see customers. */
  waIdMasked: string;
  waId: string;
  language: string | null;
  last: { id: number; conversationId: number; preview: string; role: 'user' | 'assistant'; kind: MessageKind; type: string | null; at: string };
  /** The customer wrote last: staff or the assistant still owe an answer. (Not an unread count.) */
  needsReply: boolean;
  handling: {
    state: 'AI_ACTIVE' | 'HUMAN_REQUESTED' | 'HUMAN_ACTIVE' | 'RESOLVED';
    handoffId: number | null;
    assignedAdminId: number | null;
    assignedToName: string | null;
    requestedAt: string | null;
    requestCount: number;
  };
}

export interface InboxCounts {
  all: number;
  waiting: number;
  in_progress: number;
  ai: number;
  resolved: number;
  needs_reply: number;
}

interface Row {
  customer_id: number;
  display_name: string | null;
  wa_id: string;
  language: string | null;
  last_id: number;
  conversation_id: number;
  content: string;
  role: 'user' | 'assistant';
  message_type: string | null;
  metadata: string | null;
  created_at: string;
  handoff_id: number | null;
  state: string | null;
  assigned_admin_id: number | null;
  assigned_name: string | null;
  requested_at: string | null;
  request_count: number | null;
}

/** The newest visible message of every customer of the account, joined with the customer and any open handoff — one query, no per-row lookups. */
const BASE = `
  WITH last AS (
    SELECT c.customer_id AS customer_id, MAX(m.id) AS last_id
    FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.whatsapp_account_id = @accountId AND ${VISIBLE}
    GROUP BY c.customer_id
  )
  SELECT cu.id AS customer_id, cu.display_name, cu.wa_id, cu.language,
         lm.id AS last_id, lm.conversation_id, lm.content, lm.role, lm.message_type, lm.metadata, lm.created_at,
         h.id AS handoff_id, h.state, h.assigned_admin_id, h.requested_at, h.request_count,
         COALESCE(NULLIF(au.display_name, ''), au.email, au.username) AS assigned_name
  FROM last l
  JOIN customers cu ON cu.id = l.customer_id AND cu.whatsapp_account_id = @accountId
  JOIN conversation_messages lm ON lm.id = l.last_id
  LEFT JOIN human_handoffs h ON h.customer_id = cu.id AND h.state <> 'AI_ACTIVE'
  LEFT JOIN admin_users au ON au.id = h.assigned_admin_id`;

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function where(query: InboxQuery, params: Record<string, unknown>): string {
  const clauses: string[] = [];
  const q = (query.q ?? '').trim().slice(0, 80);
  if (q) {
    const digits = normalizeNumerals(q).replace(/[^\d]/g, '');
    const parts = ['cu.display_name LIKE @term ESCAPE \'\\\''];
    params.term = `%${escapeLike(q)}%`;
    if (digits.length >= 3) {
      parts.push('cu.wa_id LIKE @digits ESCAPE \'\\\'');
      params.digits = `%${escapeLike(digits)}%`;
    }
    clauses.push(`(${parts.join(' OR ')})`);
  }
  switch (query.handling) {
    case 'waiting': clauses.push(`h.state = 'HUMAN_REQUESTED'`); break;
    case 'in_progress': clauses.push(`h.state = 'HUMAN_ACTIVE'`); break;
    case 'resolved': clauses.push(`h.state = 'RESOLVED'`); break;
    case 'ai': clauses.push('h.id IS NULL'); break;
    case 'needs_reply': clauses.push(`lm.role = 'user'`); break;
    default: break;
  }
  if (query.assignee === 'me') { clauses.push('h.assigned_admin_id = @viewer'); params.viewer = query.viewerAdminId; }
  else if (query.assignee === 'unassigned') clauses.push('h.id IS NOT NULL AND h.assigned_admin_id IS NULL');
  else if (typeof query.assignee === 'number') { clauses.push('h.assigned_admin_id = @assignee'); params.assignee = query.assignee; }
  return clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
}

function kindOf(role: 'user' | 'assistant', metadata: string | null): MessageKind {
  if (role === 'user') return 'customer';
  try {
    const meta = metadata ? (JSON.parse(metadata) as { staff?: boolean; templateKey?: string }) : {};
    return meta.staff ? 'staff' : meta.templateKey ? 'auto' : 'ai';
  } catch {
    return 'ai';
  }
}

function toItem(r: Row): InboxItem {
  const content = r.content.replace(/\s+/g, ' ').trim();
  return {
    customerId: r.customer_id,
    name: r.display_name,
    waIdMasked: maskWaId(r.wa_id),
    waId: r.wa_id,
    language: r.language,
    last: { id: r.last_id, conversationId: r.conversation_id, preview: content.length > PREVIEW_CHARS ? `${content.slice(0, PREVIEW_CHARS)}…` : content, role: r.role, kind: kindOf(r.role, r.metadata), type: r.message_type, at: r.created_at },
    needsReply: r.role === 'user',
    handling: {
      state: (r.state as InboxItem['handling']['state'] | null) ?? 'AI_ACTIVE',
      handoffId: r.handoff_id,
      assignedAdminId: r.assigned_admin_id,
      assignedToName: r.assigned_name,
      requestedAt: r.requested_at,
      requestCount: r.request_count ?? 0,
    },
  };
}

export function clampPage(limit: unknown, offset: unknown): { limit: number; offset: number } {
  const l = Number.parseInt(String(limit ?? DEFAULT_PAGE), 10);
  const o = Number.parseInt(String(offset ?? 0), 10);
  return { limit: Math.max(1, Math.min(Number.isFinite(l) ? l : DEFAULT_PAGE, MAX_PAGE)), offset: Math.max(0, Number.isFinite(o) ? o : 0) };
}

/** One page of the inbox for the current account. Search, filters and sorting all happen in the database. */
export function listInbox(query: InboxQuery, accountId: number = currentAccountId(), db: Database.Database = getDb()): { items: InboxItem[]; total: number; limit: number; offset: number } {
  const { limit, offset } = clampPage(query.limit, query.offset);
  const params: Record<string, unknown> = { accountId };
  const filter = where(query, params);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${BASE} ${filter})`).get(params) as { n: number }).n;
  const order = query.sort === 'waiting_first'
    ? `ORDER BY CASE WHEN h.state = 'HUMAN_REQUESTED' THEN 0 ELSE 1 END, lm.created_at DESC, lm.id DESC`
    : 'ORDER BY lm.created_at DESC, lm.id DESC';
  const rows = db.prepare(`${BASE} ${filter} ${order} LIMIT @limit OFFSET @offset`).all({ ...params, limit, offset }) as Row[];
  return { items: rows.map(toItem), total, limit, offset };
}

/** The numbers behind the filter chips (whole account, not narrowed by the search box). */
export function inboxCounts(accountId: number = currentAccountId(), db: Database.Database = getDb()): InboxCounts {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN state = 'HUMAN_REQUESTED' THEN 1 ELSE 0 END), 0) AS waiting,
              COALESCE(SUM(CASE WHEN state = 'HUMAN_ACTIVE' THEN 1 ELSE 0 END), 0) AS in_progress,
              COALESCE(SUM(CASE WHEN handoff_id IS NULL THEN 1 ELSE 0 END), 0) AS ai,
              COALESCE(SUM(CASE WHEN state = 'RESOLVED' THEN 1 ELSE 0 END), 0) AS resolved,
              COALESCE(SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END), 0) AS needs_reply
       FROM (${BASE})`,
    )
    .get({ accountId }) as { total: number; waiting: number; in_progress: number; ai: number; resolved: number; needs_reply: number };
  return { all: row.total, waiting: row.waiting, in_progress: row.in_progress, ai: row.ai, resolved: row.resolved, needs_reply: row.needs_reply };
}

/**
 * A cheap fingerprint of "has anything changed in this account's inbox": the newest message id, the newest handoff change and the
 * number of open handoffs. The browser asks for this every few seconds and only reloads the list when it differs.
 */
export function inboxRevision(accountId: number = currentAccountId(), db: Database.Database = getDb()): string {
  const messages = (db.prepare(`SELECT COALESCE(MAX((SELECT MAX(m.id) FROM conversation_messages m WHERE m.conversation_id = c.id)), 0) AS id FROM conversations c WHERE c.whatsapp_account_id = ?`).get(accountId) as { id: number }).id;
  const handoffs = db.prepare(`SELECT COALESCE(MAX(updated_at), '') AS at, COUNT(*) AS n FROM human_handoffs WHERE whatsapp_account_id = ?`).get(accountId) as { at: string; n: number };
  return `${messages}:${handoffs.at}:${handoffs.n}`;
}

// ------------------------------------------------------------------ the conversation of one customer

export type MessageKind = 'customer' | 'ai' | 'auto' | 'staff';

export interface ThreadMessage {
  id: number;
  conversationId: number;
  kind: MessageKind;
  direction: 'inbound' | 'outbound' | null;
  type: string;
  content: string;
  at: string;
  staffAdminId: number | null;
  staffName: string | null;
  /** Staff replies only: "sent" = accepted by the account's WhatsApp connection. No delivered/read state exists, so none is shown. */
  status: 'sent' | null;
}

interface MessageRow {
  id: number;
  conversation_id: number;
  role: 'user' | 'assistant';
  content: string;
  direction: 'inbound' | 'outbound' | null;
  message_type: string | null;
  metadata: string | null;
  created_at: string;
}

export function customerInAccount(customerId: number, accountId: number = currentAccountId(), db: Database.Database = getDb()) {
  return db.prepare('SELECT id, display_name, wa_id, language, whatsapp_account_id FROM customers WHERE id = ? AND whatsapp_account_id = ?').get(customerId, accountId) as
    | { id: number; display_name: string | null; wa_id: string; language: string | null; whatsapp_account_id: number }
    | undefined;
}

/**
 * Messages of one customer across all of their conversations in this account, in order. `before` pages back through history,
 * `after` returns only what is new (the browser's incremental refresh); with neither, the newest `limit` messages. Never more than
 * MAX_THREAD_PAGE rows, never another account's.
 */
export function threadMessages(
  customerId: number,
  options: { before?: number; after?: number; limit?: number } = {},
  accountId: number = currentAccountId(),
  db: Database.Database = getDb(),
): { messages: ThreadMessage[]; hasMore: boolean; latestId: number; oldestId: number | null } {
  const limit = Math.max(1, Math.min(Number.isFinite(options.limit) ? (options.limit as number) : DEFAULT_THREAD_PAGE, MAX_THREAD_PAGE));
  const base = `SELECT m.id, m.conversation_id, m.role, m.content, m.direction, m.message_type, m.metadata, m.created_at
                FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
                WHERE c.customer_id = @customerId AND c.whatsapp_account_id = @accountId AND ${VISIBLE}`;
  let rows: MessageRow[];
  let hasMore = false;
  if (options.after !== undefined) {
    rows = db.prepare(`${base} AND m.id > @after ORDER BY m.id ASC LIMIT @limit`).all({ customerId, accountId, after: options.after, limit }) as MessageRow[];
  } else {
    const before = options.before ?? Number.MAX_SAFE_INTEGER;
    const page = db.prepare(`${base} AND m.id < @before ORDER BY m.id DESC LIMIT @limit`).all({ customerId, accountId, before, limit: limit + 1 }) as MessageRow[];
    hasMore = page.length > limit;
    rows = page.slice(0, limit).reverse();
  }

  // Staff names in ONE lookup for the whole page.
  const staffIds = new Set<number>();
  const parsed = rows.map((r) => {
    let meta: { staff?: boolean; staffAdminId?: number; templateKey?: string } = {};
    try { meta = r.metadata ? (JSON.parse(r.metadata) as typeof meta) : {}; } catch { meta = {}; }
    if (meta.staff && typeof meta.staffAdminId === 'number') staffIds.add(meta.staffAdminId);
    return { r, meta };
  });
  const names = new Map<number, string>();
  if (staffIds.size) {
    const ids = [...staffIds];
    for (const u of db.prepare(`SELECT id, COALESCE(NULLIF(display_name, ''), email, username) AS name FROM admin_users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number; name: string }[]) names.set(u.id, u.name);
  }

  const messages: ThreadMessage[] = parsed.map(({ r, meta }) => ({
    id: r.id,
    conversationId: r.conversation_id,
    kind: r.role === 'user' ? 'customer' : meta.staff ? 'staff' : meta.templateKey ? 'auto' : 'ai',
    direction: r.direction,
    type: r.message_type ?? 'text',
    content: r.content,
    at: r.created_at,
    staffAdminId: meta.staff && typeof meta.staffAdminId === 'number' ? meta.staffAdminId : null,
    staffName: meta.staff && typeof meta.staffAdminId === 'number' ? names.get(meta.staffAdminId) ?? null : null,
    status: meta.staff ? 'sent' : null,
  }));
  const latest = (db.prepare(`SELECT COALESCE(MAX(m.id), 0) AS id FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.customer_id = ? AND c.whatsapp_account_id = ? AND ${VISIBLE}`).get(customerId, accountId) as { id: number }).id;
  return { messages, hasMore, latestId: latest, oldestId: messages.length ? messages[0]!.id : null };
}
