import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { getCustomerById } from '../memory/customerRepo';
import { listCustomerFiles, publicFile, type CustomerFile } from '../files/customerFileRepo';
import { getOpenCart, cartItems, type CartItem } from '../cart/cartRepo';

/**
 * One customer, in one business: their profile, everything that happened with them (a chronological timeline built from the records
 * that already exist — requests, quotation versions, deliveries, cart changes, files, notes) and the staff notes / follow-ups.
 *
 * Nothing here copies a conversation: events point back to the conversation (and the original WhatsApp message) they came from, so the
 * Conversations page stays the one place for the chat itself. Every query is scoped to the business; a customer id from another
 * business is "not found". Internal notes are staff-only and never reach a customer.
 */

export class CustomerNotFoundError extends Error {
  status = 404;
  constructor() {
    super('customer not found');
  }
}

export interface TimelineEvent {
  /** Stable id, unique within the timeline ("request:12", "event:55"). */
  id: string;
  /** SQLite UTC timestamp of the underlying record (the original timestamp is preserved, never re-stamped). */
  at: string;
  type:
    | 'first_contact' | 'inquiry' | 'cart_item_added' | 'cart_item_removed' | 'cart_submitted' | 'status_change' | 'quotation_prepared'
    | 'quotation_finalized' | 'quotation_sent' | 'document_received' | 'document_sent' | 'note' | 'follow_up' | 'follow_up_done' | 'handoff';
  title: string;
  detail: string | null;
  actor: string | null;
  requestId: number | null;
  reference: string | null;
  fileId: number | null;
  quotationVersionId: number | null;
  /** The conversation the event belongs to, and the original WhatsApp message id when there is one. */
  conversationId: number | null;
  whatsappMessageId: string | null;
}

export interface CustomerNote {
  id: number;
  customer_id: number;
  request_id: number | null;
  body: string;
  author_admin_id: number | null;
  author_name: string | null;
  follow_up_at: string | null;
  follow_up_done_at: string | null;
  follow_up_done_by: number | null;
  created_at: string;
}

export interface StaffRef {
  adminId?: number | null;
  name?: string | null;
}

function requireCustomer(customerId: number, db: Database.Database, accountId: number) {
  const customer = getCustomerById(customerId, db, accountId);
  if (!customer) throw new CustomerNotFoundError();
  return customer;
}

// ---------------------------------------------------------------- profile

export interface CustomerProfile {
  customer: NonNullable<ReturnType<typeof getCustomerById>> & { email: string | null; company_name: string | null };
  stats: {
    inquiries: number;
    appointments: number;
    openRequests: number;
    quotationsByStatus: Record<string, number>;
    quotationsSent: number;
    filesReceived: number;
    filesSent: number;
    filesNeedingReview: number;
    notes: number;
    followUpsOutstanding: number;
    followUpsOverdue: number;
  };
  openCart: { id: number; items: CartItem[]; updatedAt: string } | null;
  requests: { id: number; reference: string; kind: string; status: string; source: string; created_at: string; updated_at: string; service: string | null }[];
  nextFollowUp: { id: number; at: string; body: string } | null;
}

const OPEN_STATUSES = ['pending', 'preparing', 'contacted', 'approved'];

export function getCustomerProfile(customerId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): CustomerProfile {
  const customer = requireCustomer(customerId, db, accountId) as CustomerProfile['customer'];
  const scalar = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n;
  const requests = db
    .prepare(`SELECT id, reference, kind, status, source, created_at, updated_at, payload FROM customer_requests WHERE customer_id = ? AND whatsapp_account_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`)
    .all(customerId, accountId) as { id: number; reference: string; kind: string; status: string; source: string; created_at: string; updated_at: string; payload: string }[];
  const quotationsByStatus: Record<string, number> = {};
  for (const r of requests) if (r.kind === 'quotation') quotationsByStatus[r.status] = (quotationsByStatus[r.status] ?? 0) + 1;
  const cart = getOpenCart(customerId, db, accountId);
  const next = db
    .prepare(`SELECT id, follow_up_at AS at, body FROM customer_notes WHERE customer_id = ? AND whatsapp_account_id = ? AND follow_up_at IS NOT NULL AND follow_up_done_at IS NULL ORDER BY follow_up_at ASC LIMIT 1`)
    .get(customerId, accountId) as { id: number; at: string; body: string } | undefined;
  return {
    customer,
    stats: {
      inquiries: requests.filter((r) => r.kind === 'quotation').length,
      appointments: requests.filter((r) => r.kind === 'appointment').length,
      openRequests: requests.filter((r) => OPEN_STATUSES.includes(r.status)).length,
      quotationsByStatus,
      quotationsSent: scalar(`SELECT COUNT(*) AS n FROM quotation_versions WHERE customer_id = ? AND whatsapp_account_id = ? AND sent_at IS NOT NULL`, customerId, accountId),
      filesReceived: scalar(`SELECT COUNT(*) AS n FROM customer_files WHERE customer_id = ? AND whatsapp_account_id = ? AND direction = 'inbound'`, customerId, accountId),
      filesSent: scalar(`SELECT COUNT(*) AS n FROM customer_files WHERE customer_id = ? AND whatsapp_account_id = ? AND direction = 'outbound'`, customerId, accountId),
      filesNeedingReview: scalar(`SELECT COUNT(*) AS n FROM customer_files WHERE customer_id = ? AND whatsapp_account_id = ? AND status = 'needs_review'`, customerId, accountId),
      notes: scalar(`SELECT COUNT(*) AS n FROM customer_notes WHERE customer_id = ? AND whatsapp_account_id = ?`, customerId, accountId),
      followUpsOutstanding: scalar(`SELECT COUNT(*) AS n FROM customer_notes WHERE customer_id = ? AND whatsapp_account_id = ? AND follow_up_at IS NOT NULL AND follow_up_done_at IS NULL`, customerId, accountId),
      followUpsOverdue: scalar(`SELECT COUNT(*) AS n FROM customer_notes WHERE customer_id = ? AND whatsapp_account_id = ? AND follow_up_at IS NOT NULL AND follow_up_done_at IS NULL AND follow_up_at < datetime('now')`, customerId, accountId),
    },
    openCart: cart ? { id: cart.id, items: cartItems(cart.id, db), updatedAt: cart.updated_at } : null,
    requests: requests.slice(0, 50).map((r) => ({ id: r.id, reference: r.reference, kind: r.kind, status: r.status, source: r.source, created_at: r.created_at, updated_at: r.updated_at, service: safeJson(r.payload).service ?? null })),
    nextFollowUp: next ?? null,
  };
}

function safeJson(text: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function updateCustomerProfile(
  customerId: number,
  input: { email?: string | null; companyName?: string | null },
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): CustomerProfile {
  requireCustomer(customerId, db, accountId);
  const email = input.email === undefined ? undefined : cleanOptional(input.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('Email address is not valid'), { status: 400 });
  const company = input.companyName === undefined ? undefined : cleanOptional(input.companyName, 200);
  db.prepare(
    `UPDATE customers SET email = CASE WHEN @setEmail THEN @email ELSE email END, company_name = CASE WHEN @setCompany THEN @company ELSE company_name END, updated_at = datetime('now')
     WHERE id = @id AND whatsapp_account_id = @accountId`,
  ).run({ id: customerId, accountId, setEmail: email === undefined ? 0 : 1, email: email ?? null, setCompany: company === undefined ? 0 : 1, company: company ?? null });
  return getCustomerProfile(customerId, db, accountId);
}

function cleanOptional(value: string | null, max: number): string | null {
  const v = (value ?? '').replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, max) : null;
}

// ---------------------------------------------------------------- notes and follow-ups

export function listNotes(customerId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): CustomerNote[] {
  requireCustomer(customerId, db, accountId);
  return db.prepare('SELECT * FROM customer_notes WHERE customer_id = ? AND whatsapp_account_id = ? ORDER BY created_at DESC, id DESC LIMIT 500').all(customerId, accountId) as CustomerNote[];
}

/** An internal note, optionally tied to one of this customer's requests and optionally with a follow-up date. Never shown to the customer. */
export function addNote(
  customerId: number,
  input: { body: string; requestId?: number | null; followUpAt?: string | null },
  staff: StaffRef,
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): CustomerNote {
  requireCustomer(customerId, db, accountId);
  const body = (input.body ?? '').replace(/\r/g, '').trim().slice(0, 4000);
  if (!body) throw Object.assign(new Error('A note cannot be empty'), { status: 400 });
  let followUp: string | null = null;
  if (input.followUpAt) {
    const parsed = Date.parse(input.followUpAt.length === 10 ? `${input.followUpAt}T00:00:00Z` : input.followUpAt);
    if (Number.isNaN(parsed)) throw Object.assign(new Error('Follow-up date is not valid'), { status: 400 });
    followUp = new Date(parsed).toISOString().slice(0, 19).replace('T', ' ');
  }
  if (input.requestId) {
    const own = db.prepare('SELECT id FROM customer_requests WHERE id = ? AND customer_id = ? AND whatsapp_account_id = ?').get(input.requestId, customerId, accountId);
    if (!own) throw Object.assign(new Error('That request does not belong to this customer'), { status: 400 });
  }
  const result = db
    .prepare(`INSERT INTO customer_notes (whatsapp_account_id, customer_id, request_id, body, author_admin_id, author_name, follow_up_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(accountId, customerId, input.requestId ?? null, body, staff.adminId ?? null, staff.name?.slice(0, 100) ?? null, followUp);
  return db.prepare('SELECT * FROM customer_notes WHERE id = ?').get(result.lastInsertRowid) as CustomerNote;
}

export function completeFollowUp(customerId: number, noteId: number, staff: StaffRef, db: Database.Database = getDb(), accountId: number = currentAccountId()): CustomerNote {
  requireCustomer(customerId, db, accountId);
  const note = db.prepare('SELECT * FROM customer_notes WHERE id = ? AND customer_id = ? AND whatsapp_account_id = ?').get(noteId, customerId, accountId) as CustomerNote | undefined;
  if (!note || !note.follow_up_at) throw Object.assign(new Error('Follow-up not found'), { status: 404 });
  db.prepare(`UPDATE customer_notes SET follow_up_done_at = COALESCE(follow_up_done_at, datetime('now')), follow_up_done_by = COALESCE(follow_up_done_by, ?) WHERE id = ?`).run(staff.adminId ?? null, noteId);
  return db.prepare('SELECT * FROM customer_notes WHERE id = ?').get(noteId) as CustomerNote;
}

// ---------------------------------------------------------------- timeline

export interface TimelineParams {
  q?: string;
  types?: string[];
  from?: string;
  to?: string;
  /** 'desc' (newest first, the default) or 'asc'. */
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const PER_SOURCE_LIMIT = 1000;

const TYPE_RANK: Record<TimelineEvent['type'], number> = {
  first_contact: 0, cart_item_added: 1, cart_item_removed: 2, cart_submitted: 3, inquiry: 4, document_received: 5, handoff: 5, note: 6, follow_up: 6,
  status_change: 7, quotation_prepared: 8, quotation_finalized: 9, quotation_sent: 10, document_sent: 10, follow_up_done: 11,
};
const numericId = (id: string): number => Number(id.split(':')[1]) || 0;

export function getCustomerTimeline(
  customerId: number,
  params: TimelineParams = {},
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): { events: TimelineEvent[]; total: number } {
  const customer = requireCustomer(customerId, db, accountId);
  const all = db.prepare.bind(db);
  const events: TimelineEvent[] = [];
  const base = { actor: null, requestId: null, reference: null, fileId: null, quotationVersionId: null, conversationId: null, whatsappMessageId: null } as const;

  // The customer's conversations, to say which one an event belongs to (the latest conversation that had started by then).
  const conversations = all('SELECT id, started_at AS created_at FROM conversations WHERE customer_id = ? AND whatsapp_account_id = ? ORDER BY started_at ASC, id ASC').all(customerId, accountId) as { id: number; created_at: string }[];
  const conversationAt = (at: string): number | null => {
    let found: number | null = null;
    for (const c of conversations) {
      if (c.created_at <= at) found = c.id;
      else break;
    }
    return found ?? conversations[0]?.id ?? null;
  };

  const firstMessage = all(`SELECT m.created_at AS at, m.conversation_id AS conversationId, m.whatsapp_message_id AS messageId FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.customer_id = ? AND c.whatsapp_account_id = ? AND m.direction = 'inbound' ORDER BY m.id ASC LIMIT 1`).get(customerId, accountId) as { at: string; conversationId: number; messageId: string | null } | undefined;
  events.push({ ...base, id: 'first-contact', at: firstMessage?.at ?? customer.created_at, type: 'first_contact', title: 'First contact', detail: null, conversationId: firstMessage?.conversationId ?? null, whatsappMessageId: firstMessage?.messageId ?? null });

  const requests = all(`SELECT id, reference, kind, status, source, payload, created_at FROM customer_requests WHERE customer_id = ? AND whatsapp_account_id = ? ORDER BY id ASC LIMIT ${PER_SOURCE_LIMIT}`).all(customerId, accountId) as { id: number; reference: string; kind: string; status: string; source: string; payload: string; created_at: string }[];
  const refById = new Map(requests.map((r) => [r.id, r.reference]));
  for (const r of requests) {
    const payload = safeJson(r.payload);
    const what = r.kind === 'quotation' ? (r.source === 'cart' ? 'Inquiry submitted from the cart' : 'Quotation request') : 'Appointment request';
    events.push({ ...base, id: `request:${r.id}`, at: r.created_at, type: 'inquiry', title: `${what} ${r.reference}`, detail: [payload.service, payload.details].filter(Boolean).join('\n') || null, requestId: r.id, reference: r.reference, conversationId: conversationAt(r.created_at) });
  }

  const statusEvents = all(`SELECT e.id, e.request_id, e.reference, e.old_status, e.new_status, e.actor, e.actor_detail, e.reason, e.created_at FROM request_events e JOIN customer_requests r ON r.id = e.request_id WHERE r.customer_id = ? AND r.whatsapp_account_id = ? ORDER BY e.id ASC LIMIT ${PER_SOURCE_LIMIT}`).all(customerId, accountId) as { id: number; request_id: number; reference: string; old_status: string | null; new_status: string; actor: string; actor_detail: string | null; reason: string | null; created_at: string }[];
  for (const e of statusEvents) {
    const changed = e.old_status !== e.new_status;
    events.push({ ...base, id: `event:${e.id}`, at: e.created_at, type: 'status_change', title: changed ? `${e.reference}: ${e.old_status ?? 'new'} → ${e.new_status}` : `${e.reference}: ${e.reason ?? 'update'}`, detail: changed ? e.reason : null, actor: e.actor_detail ?? e.actor, requestId: e.request_id, reference: e.reference });
  }

  const versions = all(`SELECT id, request_id, version, quote_number, state, total_minor, currency, prepared_by_name, finalized_at, sent_at, created_at FROM quotation_versions WHERE customer_id = ? AND whatsapp_account_id = ? ORDER BY id ASC`).all(customerId, accountId) as { id: number; request_id: number; version: number; quote_number: string; state: string; total_minor: number | null; currency: string | null; prepared_by_name: string | null; finalized_at: string | null; sent_at: string | null; created_at: string }[];
  for (const v of versions) {
    const total = v.total_minor !== null ? `${(v.total_minor / 100).toFixed(2)}${v.currency ? ` ${v.currency}` : ''}` : null;
    const ref = refById.get(v.request_id) ?? null;
    const q = { requestId: v.request_id, reference: ref, quotationVersionId: v.id };
    events.push({ ...base, ...q, id: `quote-prepared:${v.id}`, at: v.created_at, type: 'quotation_prepared', title: `Quotation ${v.quote_number} prepared`, detail: total ? `Total ${total}` : null, actor: v.prepared_by_name });
    if (v.finalized_at) events.push({ ...base, ...q, id: `quote-final:${v.id}`, at: v.finalized_at, type: 'quotation_finalized', title: `Quotation ${v.quote_number} finalised`, detail: total ? `Total ${total}` : null });
    if (v.sent_at) events.push({ ...base, ...q, id: `quote-sent:${v.id}`, at: v.sent_at, type: 'quotation_sent', title: `Quotation ${v.quote_number} sent to the customer`, detail: total ? `Total ${total}` : null });
  }

  const items = all(`SELECT i.id, i.description, i.quantity, i.created_at, i.removed_at, c.request_id FROM inquiry_cart_items i JOIN inquiry_carts c ON c.id = i.cart_id WHERE c.customer_id = ? AND c.whatsapp_account_id = ? ORDER BY i.id ASC LIMIT ${PER_SOURCE_LIMIT}`).all(customerId, accountId) as { id: number; description: string; quantity: number | null; created_at: string; removed_at: string | null; request_id: number | null }[];
  for (const i of items) {
    const label = `${i.description}${i.quantity ? ` × ${i.quantity}` : ''}`;
    events.push({ ...base, id: `cart-add:${i.id}`, at: i.created_at, type: 'cart_item_added', title: 'Added to the inquiry cart', detail: label, conversationId: conversationAt(i.created_at) });
    if (i.removed_at) events.push({ ...base, id: `cart-remove:${i.id}`, at: i.removed_at, type: 'cart_item_removed', title: 'Removed from the inquiry cart', detail: label, conversationId: conversationAt(i.removed_at) });
  }
  const carts = all(`SELECT id, request_id, submitted_at FROM inquiry_carts WHERE customer_id = ? AND whatsapp_account_id = ? AND submitted_at IS NOT NULL`).all(customerId, accountId) as { id: number; request_id: number | null; submitted_at: string }[];
  for (const c of carts) events.push({ ...base, id: `cart-submit:${c.id}`, at: c.submitted_at, type: 'cart_submitted', title: 'Inquiry cart submitted', detail: null, requestId: c.request_id, reference: c.request_id ? refById.get(c.request_id) ?? null : null, conversationId: conversationAt(c.submitted_at) });

  for (const f of listCustomerFiles({ customerId, limit: 500, accountId }, db)) {
    const inbound = f.direction === 'inbound';
    events.push({
      ...base, id: `file:${f.id}`, at: f.created_at, type: inbound ? 'document_received' : 'document_sent',
      title: `${inbound ? 'Received' : 'Sent'} ${f.kind}: ${f.original_name ?? 'file'}${f.status === 'stored' ? '' : ` (${f.status.replace('_', ' ')})`}`, detail: f.caption, fileId: f.id, requestId: f.request_id, reference: f.request_id ? refById.get(f.request_id) ?? null : null,
      quotationVersionId: f.quotation_version_id, conversationId: f.conversation_id ?? conversationAt(f.created_at), whatsappMessageId: f.whatsapp_message_id, actor: f.uploaded_by_admin_id ? `admin#${f.uploaded_by_admin_id}` : null,
    });
  }

  for (const n of listNotes(customerId, db, accountId)) {
    const q = { requestId: n.request_id, reference: n.request_id ? refById.get(n.request_id) ?? null : null, actor: n.author_name ?? (n.author_admin_id ? `admin#${n.author_admin_id}` : null) };
    events.push({ ...base, ...q, id: `note:${n.id}`, at: n.created_at, type: n.follow_up_at ? 'follow_up' : 'note', title: n.follow_up_at ? `Follow-up due ${n.follow_up_at.slice(0, 16)}` : 'Staff note', detail: n.body });
    if (n.follow_up_done_at) events.push({ ...base, ...q, id: `note-done:${n.id}`, at: n.follow_up_done_at, type: 'follow_up_done', title: 'Follow-up completed', detail: n.body });
  }

  const handoffs = all(`SELECT id, requested_at, source, reason FROM human_handoffs WHERE customer_id = ? AND whatsapp_account_id = ?`).all(customerId, accountId) as { id: number; requested_at: string; source: string; reason: string | null }[];
  for (const h of handoffs) events.push({ ...base, id: `handoff:${h.id}`, at: h.requested_at, type: 'handoff', title: 'Asked for a person', detail: h.reason, conversationId: conversationAt(h.requested_at) });

  const wanted = params.types?.length ? new Set(params.types) : null;
  const q = params.q?.trim().toLowerCase();
  const from = params.from ? normalizeBoundary(params.from, false) : null;
  const to = params.to ? normalizeBoundary(params.to, true) : null;
  const filtered = events.filter((e) => {
    if (wanted && !wanted.has(e.type)) return false;
    if (from && e.at < from) return false;
    if (to && e.at > to) return false;
    if (q && !`${e.title}\n${e.detail ?? ''}\n${e.reference ?? ''}\n${e.actor ?? ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const dir = params.order === 'asc' ? 1 : -1;
  // Timestamps have one-second resolution: events of the same second keep the order the work actually happens in, then their own id.
  filtered.sort((a, b) => (a.at < b.at ? -dir : a.at > b.at ? dir : (TYPE_RANK[a.type] - TYPE_RANK[b.type] || numericId(a.id) - numericId(b.id)) * dir));
  const limit = Math.max(1, Math.min(params.limit ?? 100, 500));
  const offset = Math.max(0, params.offset ?? 0);
  return { events: filtered.slice(offset, offset + limit), total: filtered.length };
}

/** "2026-10-01" → start/end of that UTC day in SQLite format; a full timestamp is normalised. */
export function normalizeBoundary(value: string, endOfDay: boolean): string {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v} ${endOfDay ? '23:59:59' : '00:00:00'}`;
  const parsed = Date.parse(v);
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------- documents

export interface CustomerDocument {
  file: Record<string, unknown>;
  reference: string | null;
  /** Outbound files: queued / delivered / failed, from the delivery record. Null for received files. */
  delivery: 'queued' | 'delivered' | 'failed' | null;
  needsReview: boolean;
}

export function listCustomerDocuments(customerId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): CustomerDocument[] {
  requireCustomer(customerId, db, accountId);
  const refs = new Map((db.prepare('SELECT id, reference FROM customer_requests WHERE customer_id = ? AND whatsapp_account_id = ?').all(customerId, accountId) as { id: number; reference: string }[]).map((r) => [r.id, r.reference]));
  return listCustomerFiles({ customerId, limit: 500, accountId }, db).map((f) => documentView(f, refs, db));
}

function documentView(f: CustomerFile, refs: Map<number, string>, db: Database.Database): CustomerDocument {
  let delivery: CustomerDocument['delivery'] = null;
  if (f.direction === 'outbound' && f.quotation_version_id) {
    const row = db.prepare(`SELECT o.status FROM quotation_versions v JOIN notification_outbox o ON o.id = v.sent_outbox_id WHERE v.id = ?`).get(f.quotation_version_id) as { status: string } | undefined;
    delivery = row ? (row.status === 'sent' ? 'delivered' : row.status === 'failed' ? 'failed' : 'queued') : null;
  }
  return { file: publicFile(f), reference: f.request_id ? refs.get(f.request_id) ?? null : null, delivery, needsReview: f.status === 'needs_review' };
}

/** The review queue: files whose customer is not certain, and files that could not be stored. Whole business. */
export function listFileExceptions(db: Database.Database = getDb(), accountId: number = currentAccountId()): CustomerDocument[] {
  const rows = db
    .prepare(`SELECT * FROM customer_files WHERE whatsapp_account_id = ? AND (customer_id IS NULL OR status IN ('needs_review', 'failed', 'too_large', 'unsupported')) ORDER BY created_at DESC, id DESC LIMIT 200`)
    .all(accountId) as CustomerFile[];
  return rows.map((f) => documentView(f, new Map(), db));
}
