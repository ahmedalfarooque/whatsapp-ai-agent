import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { logger } from '../logger';

/**
 * The human-handoff lifecycle of one customer of one WhatsApp account, stored in the database (so it survives restarts and
 * reconnects). The one rule everything else relies on:
 *
 *     a customer whose latest handoff is HUMAN_REQUESTED, HUMAN_ACTIVE or RESOLVED is HELD — the assistant stays silent for them —
 *     until the conversation is explicitly returned to the AI (state AI_ACTIVE).
 *
 *   AI_ACTIVE ──request──▶ HUMAN_REQUESTED ──accept──▶ HUMAN_ACTIVE ──resolve──▶ RESOLVED ──return──▶ AI_ACTIVE
 *
 * A customer has at most ONE handoff that is not AI_ACTIVE (a unique index), so repeating the request updates that handoff.
 * Every mutation is one transaction that also keeps the old `customers.automation_paused` flag in step (older screens read it).
 * Authorization is decided by the caller (the dashboard layer); this module enforces ownership: a handoff is only ever found
 * through its own account, and only the assigned handler (or someone with manage rights) may act on one that is taken.
 */

export type HandoffState = 'HUMAN_REQUESTED' | 'HUMAN_ACTIVE' | 'RESOLVED' | 'AI_ACTIVE';
export type HandoffSource = 'customer' | 'menu' | 'ai' | 'staff' | 'migrated';
export const HOLDING_STATES: readonly HandoffState[] = ['HUMAN_REQUESTED', 'HUMAN_ACTIVE', 'RESOLVED'];

export type HandoffActor =
  | { type: 'customer' }
  | { type: 'assistant' }
  | { type: 'system' }
  /** canManage: may act on a handoff that another staff member owns (the "manage" level of the support feature). */
  | { type: 'staff'; adminId: number; canManage: boolean };

export class HandoffError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: 'not_found' | 'invalid_state' | 'owned_by_other' | 'forbidden' | 'invalid',
  ) {
    super(message);
    this.name = 'HandoffError';
  }
}

interface Row {
  id: number;
  whatsapp_account_id: number;
  customer_id: number;
  conversation_id: number | null;
  state: HandoffState;
  source: HandoffSource;
  reason: string | null;
  request_count: number;
  requested_at: string;
  last_requested_at: string;
  assigned_admin_id: number | null;
  accepted_at: string | null;
  resolved_at: string | null;
  resolved_by: number | null;
  returned_at: string | null;
  returned_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface Handoff {
  id: number;
  accountId: number;
  customerId: number;
  conversationId: number | null;
  state: HandoffState;
  source: HandoffSource;
  reason: string | null;
  requestCount: number;
  requestedAt: string;
  lastRequestedAt: string;
  assignedAdminId: number | null;
  acceptedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: number | null;
  returnedAt: string | null;
  returnedBy: number | null;
  createdAt: string;
  updatedAt: string;
}

function toHandoff(r: Row): Handoff {
  return {
    id: r.id, accountId: r.whatsapp_account_id, customerId: r.customer_id, conversationId: r.conversation_id, state: r.state, source: r.source, reason: r.reason,
    requestCount: r.request_count, requestedAt: r.requested_at, lastRequestedAt: r.last_requested_at, assignedAdminId: r.assigned_admin_id, acceptedAt: r.accepted_at,
    resolvedAt: r.resolved_at, resolvedBy: r.resolved_by, returnedAt: r.returned_at, returnedBy: r.returned_by, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const actorType = (a: HandoffActor): 'customer' | 'assistant' | 'staff' | 'system' => a.type;
const actorAdmin = (a: HandoffActor): number | null => (a.type === 'staff' ? a.adminId : null);

function event(db: Database.Database, h: { id: number; whatsapp_account_id: number }, name: string, from: HandoffState | null, to: HandoffState | null, actor: HandoffActor, detail?: string | null): void {
  db.prepare(
    `INSERT INTO human_handoff_events (handoff_id, whatsapp_account_id, event, from_state, to_state, actor_type, actor_admin_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(h.id, h.whatsapp_account_id, name, from, to, actorType(actor), actorAdmin(actor), detail ? detail.slice(0, 300) : null);
}

/** Keeps the legacy `customers.automation_paused` columns in step with the handoff (older screens and counts read them). */
function syncPauseFlag(db: Database.Database, customerId: number, held: boolean, reason: string | null): void {
  if (held) {
    db.prepare(
      `UPDATE customers SET automation_paused = 1, paused_at = COALESCE(paused_at, datetime('now')), pause_reason = COALESCE(@reason, pause_reason), updated_at = datetime('now') WHERE id = @id`,
    ).run({ id: customerId, reason });
  } else {
    db.prepare(`UPDATE customers SET automation_paused = 0, paused_at = NULL, pause_reason = NULL, updated_at = datetime('now') WHERE id = ?`).run(customerId);
  }
}

function customerRow(db: Database.Database, customerId: number): { id: number; whatsapp_account_id: number; automation_paused: number; pause_reason: string | null } {
  const c = db.prepare('SELECT id, whatsapp_account_id, automation_paused, pause_reason FROM customers WHERE id = ?').get(customerId) as
    | { id: number; whatsapp_account_id: number; automation_paused: number; pause_reason: string | null }
    | undefined;
  if (!c) throw new HandoffError('Customer not found', 404, 'not_found');
  return c;
}

function openRow(db: Database.Database, customerId: number): Row | undefined {
  return db.prepare(`SELECT * FROM human_handoffs WHERE customer_id = ? AND state <> 'AI_ACTIVE'`).get(customerId) as Row | undefined;
}

function rowById(db: Database.Database, id: number, accountId: number): Row {
  const row = db.prepare('SELECT * FROM human_handoffs WHERE id = ? AND whatsapp_account_id = ?').get(id, accountId) as Row | undefined;
  if (!row) throw new HandoffError('Handoff not found', 404, 'not_found'); // a handoff of another account is simply "not found"
  return row;
}

// ---------------------------------------------------------------- reading

/** The handoff currently holding this customer (HUMAN_REQUESTED, HUMAN_ACTIVE or RESOLVED), or null when the assistant may answer. */
export function getHold(customerId: number, db: Database.Database = getDb()): Handoff | null {
  const row = openRow(db, customerId);
  if (row) return toHandoff(row);
  // A customer paused by an older version (or by hand in the database) with no handoff row yet is held too: adopt it.
  const c = db.prepare('SELECT id, whatsapp_account_id, automation_paused, pause_reason FROM customers WHERE id = ?').get(customerId) as
    | { id: number; whatsapp_account_id: number; automation_paused: number; pause_reason: string | null }
    | undefined;
  if (!c || c.automation_paused !== 1) return null;
  return requestHandoff({ customerId, source: 'migrated', reason: c.pause_reason }, { type: 'system' }, db).handoff;
}

/** The open handoff of a customer, read-only (unlike getHold it never adopts or creates anything) — for screens. */
export function getOpenHandoff(customerId: number, db: Database.Database = getDb()): Handoff | null {
  const row = openRow(db, customerId);
  return row ? toHandoff(row) : null;
}

export function getHandoff(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): Handoff {
  return toHandoff(rowById(db, id, accountId));
}

export function getHandoffEvents(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()) {
  rowById(db, id, accountId);
  return (db.prepare('SELECT id, event, from_state, to_state, actor_type, actor_admin_id, detail, created_at FROM human_handoff_events WHERE handoff_id = ? ORDER BY id').all(id) as {
    id: number; event: string; from_state: string | null; to_state: string | null; actor_type: string; actor_admin_id: number | null; detail: string | null; created_at: string;
  }[]).map((e) => ({ id: e.id, event: e.event, from: e.from_state, to: e.to_state, actor: e.actor_type, actorAdminId: e.actor_admin_id, detail: e.detail, at: e.created_at }));
}

export interface HandoffListItem extends Handoff {
  customerName: string | null;
  customerWaId: string;
  customerLanguage: string | null;
  assignedToName: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
}

const STATE_ORDER = `CASE h.state WHEN 'HUMAN_REQUESTED' THEN 0 WHEN 'HUMAN_ACTIVE' THEN 1 WHEN 'RESOLVED' THEN 2 ELSE 3 END`;

/** The handoffs of ONE account: waiting first (oldest request first), then those in progress, then resolved ones awaiting the AI. */
export function listHandoffs(
  options: { states?: readonly HandoffState[]; limit?: number } = {},
  accountId: number = currentAccountId(),
  db: Database.Database = getDb(),
): HandoffListItem[] {
  const states = (options.states?.length ? options.states : HOLDING_STATES).filter((s) => ['HUMAN_REQUESTED', 'HUMAN_ACTIVE', 'RESOLVED', 'AI_ACTIVE'].includes(s));
  const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
  const rows = db
    .prepare(
      `SELECT h.*, cu.display_name AS cu_name, cu.wa_id AS cu_wa, cu.language AS cu_lang,
              COALESCE(NULLIF(au.display_name, ''), au.email, au.username) AS assigned_name,
              (SELECT m.content FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
                WHERE c.customer_id = h.customer_id AND m.role = 'user' ORDER BY m.id DESC LIMIT 1) AS last_message,
              (SELECT MAX(m.created_at) FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
                WHERE c.customer_id = h.customer_id) AS last_message_at
       FROM human_handoffs h
       JOIN customers cu ON cu.id = h.customer_id
       LEFT JOIN admin_users au ON au.id = h.assigned_admin_id
       WHERE h.whatsapp_account_id = ? AND h.state IN (${states.map(() => '?').join(',')})
       ORDER BY ${STATE_ORDER}, CASE WHEN h.state = 'HUMAN_REQUESTED' THEN h.requested_at END ASC, h.updated_at DESC
       LIMIT ?`,
    )
    .all(accountId, ...states, limit) as (Row & { cu_name: string | null; cu_wa: string; cu_lang: string | null; assigned_name: string | null; last_message: string | null; last_message_at: string | null })[];
  return rows.map((r) => ({
    ...toHandoff(r),
    customerName: r.cu_name,
    customerWaId: r.cu_wa,
    customerLanguage: r.cu_lang,
    assignedToName: r.assigned_name,
    lastMessage: r.last_message,
    lastMessageAt: r.last_message_at,
  }));
}

export function handoffCounts(accountId: number = currentAccountId(), db: Database.Database = getDb()): { waiting: number; active: number; resolved: number } {
  const rows = db.prepare(`SELECT state, COUNT(*) AS n FROM human_handoffs WHERE whatsapp_account_id = ? AND state <> 'AI_ACTIVE' GROUP BY state`).all(accountId) as { state: HandoffState; n: number }[];
  const n = (s: HandoffState) => rows.find((r) => r.state === s)?.n ?? 0;
  return { waiting: n('HUMAN_REQUESTED'), active: n('HUMAN_ACTIVE'), resolved: n('RESOLVED') };
}

// ---------------------------------------------------------------- transitions

export type RequestOutcome = 'created' | 'repeated' | 'reopened';

/**
 * A customer (or the assistant, or the menu) asks for a person. Creates the handoff, or — when one already holds this
 * customer — only counts the repetition. A RESOLVED handoff asked for again is reopened for staff.
 */
export function requestHandoff(
  input: { customerId: number; conversationId?: number | null; source: HandoffSource; reason?: string | null },
  actor: HandoffActor = { type: 'customer' },
  db: Database.Database = getDb(),
): { handoff: Handoff; outcome: RequestOutcome } {
  const result = requestHandoffCore(input, actor, db);
  // A customer, the assistant or the menu asking for a person (not a repeat, not staff or a migration): features that keep their own record of the
  // customer's enquiry (the real estate add-on) are told once, after the handoff is saved. A hook never changes or blocks the handoff.
  if ((result.outcome === 'created' || result.outcome === 'reopened') && (input.source === 'customer' || input.source === 'menu' || input.source === 'ai')) {
    for (const hook of requestedHooks) {
      try {
        hook({ customerId: input.customerId, accountId: customerRow(db, input.customerId).whatsapp_account_id, conversationId: input.conversationId ?? null, source: input.source, outcome: result.outcome });
      } catch (error) {
        logger.warn({ errorName: (error as Error)?.name }, 'handoff requested hook failed');
      }
    }
  }
  return result;
}

export interface HandoffRequestedInfo { customerId: number; accountId: number; conversationId: number | null; source: HandoffSource; outcome: 'created' | 'reopened' }
const requestedHooks: Array<(info: HandoffRequestedInfo) => void> = [];
export function onHandoffRequested(hook: (info: HandoffRequestedInfo) => void): void {
  if (!requestedHooks.includes(hook)) requestedHooks.push(hook);
}

function requestHandoffCore(
  input: { customerId: number; conversationId?: number | null; source: HandoffSource; reason?: string | null },
  actor: HandoffActor,
  db: Database.Database,
): { handoff: Handoff; outcome: RequestOutcome } {
  const reason = input.reason ? input.reason.slice(0, 300) : null;
  const run = db.transaction((): { handoff: Handoff; outcome: RequestOutcome } => {
    const customer = customerRow(db, input.customerId);
    const open = openRow(db, input.customerId);
    if (open) {
      if (open.state === 'RESOLVED') {
        db.prepare(
          `UPDATE human_handoffs SET state = 'HUMAN_REQUESTED', request_count = request_count + 1, last_requested_at = datetime('now'), resolved_at = NULL, resolved_by = NULL,
             assigned_admin_id = NULL, accepted_at = NULL, updated_at = datetime('now') WHERE id = ?`,
        ).run(open.id);
        event(db, open, 'reopened', 'RESOLVED', 'HUMAN_REQUESTED', actor, reason);
        syncPauseFlag(db, input.customerId, true, reason);
        return { handoff: toHandoff(rowById(db, open.id, open.whatsapp_account_id)), outcome: 'reopened' };
      }
      db.prepare(`UPDATE human_handoffs SET request_count = request_count + 1, last_requested_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(open.id);
      syncPauseFlag(db, input.customerId, true, null);
      return { handoff: toHandoff(rowById(db, open.id, open.whatsapp_account_id)), outcome: 'repeated' };
    }
    const result = db
      .prepare(
        `INSERT INTO human_handoffs (whatsapp_account_id, customer_id, conversation_id, state, source, reason) VALUES (?, ?, ?, 'HUMAN_REQUESTED', ?, ?)`,
      )
      .run(customer.whatsapp_account_id, input.customerId, input.conversationId ?? null, input.source, reason);
    const row = db.prepare('SELECT * FROM human_handoffs WHERE id = ?').get(result.lastInsertRowid) as Row;
    event(db, row, input.source === 'migrated' ? 'migrated' : 'requested', null, 'HUMAN_REQUESTED', actor, reason);
    syncPauseFlag(db, input.customerId, true, reason);
    return { handoff: toHandoff(row), outcome: 'created' };
  });
  try {
    return run();
  } catch (error) {
    // Two requests racing past the "is there one yet?" check: the unique index lets exactly one insert win; the other counts as a repeat.
    if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = openRow(db, input.customerId);
      if (existing) {
        db.prepare(`UPDATE human_handoffs SET request_count = request_count + 1, last_requested_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(existing.id);
        return { handoff: toHandoff(rowById(db, existing.id, existing.whatsapp_account_id)), outcome: 'repeated' };
      }
    }
    throw error;
  }
}

function assertCanAct(row: Row, actor: HandoffActor): void {
  if (actor.type !== 'staff') return;
  if (row.assigned_admin_id !== null && row.assigned_admin_id !== actor.adminId && !actor.canManage) {
    throw new HandoffError('This conversation is being handled by another staff member', 403, 'owned_by_other');
  }
}

/**
 * A staff member takes a waiting handoff. Atomic: of two people pressing Accept, one wins; the other is told who owns it.
 * Accepting again as the owner is a no-op (a double click or a retry never errors and never duplicates anything).
 */
export function acceptHandoff(id: number, actor: Extract<HandoffActor, { type: 'staff' }>, accountId: number = currentAccountId(), db: Database.Database = getDb()): { handoff: Handoff; changed: boolean } {
  const run = db.transaction((): { handoff: Handoff; changed: boolean } => {
    const row = rowById(db, id, accountId);
    if (row.state === 'HUMAN_ACTIVE') {
      if (row.assigned_admin_id === actor.adminId) return { handoff: toHandoff(row), changed: false };
      throw new HandoffError('Another staff member has already taken this conversation', 409, 'owned_by_other');
    }
    if (row.state !== 'HUMAN_REQUESTED') throw new HandoffError(`This handoff is ${row.state === 'RESOLVED' ? 'already resolved' : 'not waiting for staff'}`, 409, 'invalid_state');
    const res = db
      .prepare(`UPDATE human_handoffs SET state = 'HUMAN_ACTIVE', assigned_admin_id = ?, accepted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND state = 'HUMAN_REQUESTED'`)
      .run(actor.adminId, id);
    if (res.changes !== 1) throw new HandoffError('Another staff member has already taken this conversation', 409, 'owned_by_other');
    event(db, row, 'accepted', 'HUMAN_REQUESTED', 'HUMAN_ACTIVE', actor);
    syncPauseFlag(db, row.customer_id, true, null);
    return { handoff: toHandoff(rowById(db, id, accountId)), changed: true };
  });
  return run();
}

/**
 * Staff take over a conversation the customer did not ask to leave the assistant (for example one that needs a person's attention).
 * From that moment the assistant stops answering this customer, including a reply it is generating right now.
 */
export function takeOverCustomer(
  customerId: number,
  actor: Extract<HandoffActor, { type: 'staff' }>,
  accountId: number = currentAccountId(),
  db: Database.Database = getDb(),
  conversationId?: number | null,
): { handoff: Handoff; changed: boolean } {
  const run = db.transaction((): { handoff: Handoff; changed: boolean } => {
    const customer = customerRow(db, customerId);
    if (customer.whatsapp_account_id !== accountId) throw new HandoffError('Customer not found', 404, 'not_found');
    const open = openRow(db, customerId);
    if (open) {
      if (open.state === 'HUMAN_REQUESTED') return acceptHandoff(open.id, actor, accountId, db);
      if (open.state === 'HUMAN_ACTIVE') {
        if (open.assigned_admin_id === actor.adminId) return { handoff: toHandoff(open), changed: false };
        throw new HandoffError('Another staff member has already taken this conversation', 409, 'owned_by_other');
      }
      // RESOLVED: the same staff member (or anyone) continues the conversation.
      db.prepare(
        `UPDATE human_handoffs SET state = 'HUMAN_ACTIVE', assigned_admin_id = ?, accepted_at = datetime('now'), resolved_at = NULL, resolved_by = NULL, updated_at = datetime('now') WHERE id = ?`,
      ).run(actor.adminId, open.id);
      event(db, open, 'reopened', 'RESOLVED', 'HUMAN_ACTIVE', actor);
      syncPauseFlag(db, customerId, true, null);
      return { handoff: toHandoff(rowById(db, open.id, accountId)), changed: true };
    }
    const result = db
      .prepare(
        `INSERT INTO human_handoffs (whatsapp_account_id, customer_id, conversation_id, state, source, reason, assigned_admin_id, accepted_at) VALUES (?, ?, ?, 'HUMAN_ACTIVE', 'staff', 'Taken over by staff', ?, datetime('now'))`,
      )
      .run(accountId, customerId, conversationId ?? null, actor.adminId);
    const row = db.prepare('SELECT * FROM human_handoffs WHERE id = ?').get(result.lastInsertRowid) as Row;
    event(db, row, 'taken_over', null, 'HUMAN_ACTIVE', actor);
    syncPauseFlag(db, customerId, true, 'Taken over by staff');
    return { handoff: toHandoff(row), changed: true };
  });
  return run();
}

/** The owner (or someone with manage rights) marks the handoff finished. The assistant stays silent until it is returned to the AI. */
export function resolveHandoff(id: number, actor: Extract<HandoffActor, { type: 'staff' }>, accountId: number = currentAccountId(), db: Database.Database = getDb()): { handoff: Handoff; changed: boolean } {
  const run = db.transaction((): { handoff: Handoff; changed: boolean } => {
    const row = rowById(db, id, accountId);
    if (row.state === 'RESOLVED') return { handoff: toHandoff(row), changed: false };
    if (row.state !== 'HUMAN_ACTIVE') throw new HandoffError(row.state === 'HUMAN_REQUESTED' ? 'Accept the handoff before resolving it' : 'This handoff is no longer open', 409, 'invalid_state');
    assertCanAct(row, actor);
    db.prepare(`UPDATE human_handoffs SET state = 'RESOLVED', resolved_at = datetime('now'), resolved_by = ?, updated_at = datetime('now') WHERE id = ? AND state = 'HUMAN_ACTIVE'`).run(actor.adminId, id);
    event(db, row, 'resolved', 'HUMAN_ACTIVE', 'RESOLVED', actor);
    return { handoff: toHandoff(rowById(db, id, accountId)), changed: true };
  });
  return run();
}

/**
 * Hands the conversation back to the assistant. A RESOLVED handoff may be returned by any staff member with the permission; one that is
 * still waiting (declined) likewise; one that is HUMAN_ACTIVE only by its owner or someone with manage rights. The customer, too, can
 * leave a waiting or resolved handoff by asking for the menu (actor 'customer') — never one a staff member is actively handling.
 */
export function returnToAi(id: number, actor: HandoffActor, accountId: number = currentAccountId(), db: Database.Database = getDb()): { handoff: Handoff; changed: boolean } {
  const run = db.transaction((): { handoff: Handoff; changed: boolean } => {
    const row = rowById(db, id, accountId);
    if (row.state === 'AI_ACTIVE') return { handoff: toHandoff(row), changed: false };
    if (row.state === 'HUMAN_ACTIVE') {
      if (actor.type === 'customer') throw new HandoffError('A staff member is handling this conversation', 409, 'invalid_state');
      assertCanAct(row, actor);
    }
    db.prepare(`UPDATE human_handoffs SET state = 'AI_ACTIVE', returned_at = datetime('now'), returned_by = ?, updated_at = datetime('now') WHERE id = ? AND state <> 'AI_ACTIVE'`).run(actorAdmin(actor), id);
    event(db, row, 'returned_to_ai', row.state, 'AI_ACTIVE', actor);
    syncPauseFlag(db, row.customer_id, false, null);
    return { handoff: toHandoff(rowById(db, id, accountId)), changed: true };
  });
  return run();
}

/** The customer asks for the menu while waiting or after resolution: the handoff ends and the assistant answers again. */
export function customerLeavesHold(customerId: number, db: Database.Database = getDb()): boolean {
  const open = openRow(db, customerId);
  if (!open) {
    // Legacy flag without a handoff row: just release it.
    const c = db.prepare('SELECT automation_paused FROM customers WHERE id = ?').get(customerId) as { automation_paused: number } | undefined;
    if (c?.automation_paused === 1) {
      syncPauseFlag(db, customerId, false, null);
      return true;
    }
    return false;
  }
  if (open.state === 'HUMAN_ACTIVE') return false;
  returnToAi(open.id, { type: 'customer' }, open.whatsapp_account_id, db);
  return true;
}

/** Test/maintenance helper kept explicit: counts handoff rows of an account (never used by request handling). */
export function countHandoffRows(accountId: number, db: Database.Database = getDb()): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM human_handoffs WHERE whatsapp_account_id = ?').get(accountId) as { n: number }).n;
}
