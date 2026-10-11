import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { logger } from '../logger';
import { currentAccountId, runWithAccount } from '../accounts/accountContext';
import { getCustomerById } from '../memory/customerRepo';
import { getCustomerRequest, type CustomerRequest } from '../memory/customerRequestRepo';
import { changeRequestStatus, customerNotificationJid, kickOutbox, requestTemplateVars, type StatusChangeResult } from '../requests/requestService';
import { insertRequestEvent } from '../memory/customerRequestRepo';
import { enqueueNotification, listOutbox, type OutboxRow } from '../notifications/outbox';
import { resolveTemplate } from '../templates/templateRepo';
import { getCustomerFile, linkFileToRequest } from '../files/customerFileRepo';
import { MoneyError, formatMoney, formatQuantity, lineTotalMinor, parseCurrency, parseMoney, parseQuantityMilli, parseTaxRateBp, taxMinor } from './money';

/**
 * The content and the delivery of a quotation.
 *
 * A request of kind 'quotation' (created by the menu flow or the Inquiry Cart) is the canonical record. Staff prepare the quotation as
 * VERSIONS of it: a draft is edited freely; once finalised it is never changed (a change is a new version), and the version that was
 * actually delivered stays on record. Only what staff supplied is shown — an absent price, quantity, tax or validity is absent, never
 * guessed — and a total exists only when every line has both a quantity and a price. Money is integer minor units (quotations/money.ts).
 *
 * Approval is a decision; sending is a delivery. The quotation leaves through the notification outbox (retries, account-scoped,
 * idempotent per version). The request becomes "sent" only when WhatsApp accepted that message (handleQuotationOutcome).
 */

export class QuotationError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

export interface QuotationVersion {
  id: number;
  whatsapp_account_id: number;
  request_id: number;
  customer_id: number;
  version: number;
  quote_number: string;
  state: 'draft' | 'final' | 'superseded';
  currency: string | null;
  valid_until: string | null;
  subtotal_minor: number | null;
  tax_rate_bp: number | null;
  tax_minor: number | null;
  total_minor: number | null;
  customer_message: string | null;
  internal_note: string | null;
  file_id: number | null;
  prepared_by_admin_id: number | null;
  prepared_by_name: string | null;
  finalized_at: string | null;
  sent_outbox_id: number | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuotationLine {
  id: number;
  version_id: number;
  position: number;
  description: string;
  quantity_milli: number | null;
  unit_price_minor: number | null;
  line_total_minor: number | null;
}

export interface QuotationLineInput {
  description: string;
  quantity?: string | number | null;
  unitPrice?: string | number | null;
}

export interface QuotationDraftInput {
  currency?: string | null;
  validUntil?: string | null;
  taxRatePercent?: string | number | null;
  customerMessage?: string | null;
  internalNote?: string | null;
  fileId?: number | null;
  lines?: QuotationLineInput[];
}

export interface StaffActor {
  adminId?: number | null;
  name?: string | null;
}

const MAX_LINES = 100;
const DEAD_STATUSES = ['rejected', 'cancelled', 'expired', 'closed', 'completed'];

function actorDetail(actor: StaffActor): string {
  return actor.name || (actor.adminId ? `admin#${actor.adminId}` : 'dashboard');
}

function requireQuotation(requestId: number, db: Database.Database, accountId: number): CustomerRequest {
  const request = getCustomerRequest(requestId, db, accountId);
  if (!request) throw new QuotationError('Request not found', 404);
  if (request.kind !== 'quotation') throw new QuotationError('Only a quotation request has a quotation', 400);
  return request;
}

interface Totals {
  lines: { description: string; quantity_milli: number | null; unit_price_minor: number | null; line_total_minor: number | null }[];
  currency: string | null;
  subtotal: number | null;
  taxBp: number | null;
  tax: number | null;
  total: number | null;
}

/** Validates staff input and computes totals. A total exists only when EVERY line has a quantity and a price. */
function buildTotals(input: QuotationDraftInput): Totals {
  const rawLines = input.lines ?? [];
  if (rawLines.length > MAX_LINES) throw new QuotationError(`A quotation can have at most ${MAX_LINES} lines`, 400);
  const lines = rawLines.map((l, i) => {
    const description = String(l.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!description) throw new QuotationError(`Line ${i + 1} needs a description`, 400);
    const quantity = parseQuantityMilli(l.quantity ?? null, `Line ${i + 1} quantity`);
    const unit = parseMoney(l.unitPrice ?? null, `Line ${i + 1} price`);
    if (unit !== null && quantity === null) throw new QuotationError(`Line ${i + 1}: a price needs a quantity`, 400);
    return { description, quantity_milli: quantity, unit_price_minor: unit, line_total_minor: unit !== null && quantity !== null ? lineTotalMinor(quantity, unit) : null };
  });
  const currency = parseCurrency(input.currency);
  const anyPrice = lines.some((l) => l.unit_price_minor !== null);
  if (anyPrice && !currency) throw new QuotationError('A currency (for example SAR) is required when prices are given', 400);
  const complete = lines.length > 0 && lines.every((l) => l.line_total_minor !== null);
  const subtotal = complete ? lines.reduce((sum, l) => sum + (l.line_total_minor as number), 0) : null;
  const taxBp = parseTaxRateBp(input.taxRatePercent ?? null);
  if (taxBp !== null && subtotal === null) throw new QuotationError('A tax rate needs every line to have a quantity and a price', 400);
  const tax = taxBp !== null && subtotal !== null ? taxMinor(subtotal, taxBp) : null;
  const total = subtotal === null ? null : subtotal + (tax ?? 0);
  if (total !== null && total > Number.MAX_SAFE_INTEGER) throw new QuotationError('The total is too large', 400);
  return { lines, currency, subtotal, taxBp, tax, total };
}

function cleanDate(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new QuotationError('Validity date must be YYYY-MM-DD', 400);
  return v;
}

function cleanText(value: string | null | undefined, max: number): string | null {
  const v = (value ?? '').replace(/\r/g, '').trim();
  return v ? v.slice(0, max) : null;
}

export function listVersions(requestId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): QuotationVersion[] {
  return db.prepare('SELECT * FROM quotation_versions WHERE request_id = ? AND whatsapp_account_id = ? ORDER BY version ASC').all(requestId, accountId) as QuotationVersion[];
}

export function versionLines(versionId: number, db: Database.Database = getDb()): QuotationLine[] {
  return db.prepare('SELECT * FROM quotation_lines WHERE version_id = ? ORDER BY position ASC').all(versionId) as QuotationLine[];
}

export function getVersion(versionId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): QuotationVersion | undefined {
  return db.prepare('SELECT * FROM quotation_versions WHERE id = ? AND whatsapp_account_id = ?').get(versionId, accountId) as QuotationVersion | undefined;
}

/**
 * Creates the draft of a quotation, or replaces the content of the existing draft (a draft is the only editable thing). A first draft
 * on a pending/contacted request moves it to "preparing". Never touches a finalised or sent version.
 */
export function saveDraft(requestId: number, input: QuotationDraftInput, actor: StaffActor, db: Database.Database = getDb(), accountId: number = currentAccountId()): QuotationVersion {
  const request = requireQuotation(requestId, db, accountId);
  if (DEAD_STATUSES.includes(request.status)) throw new QuotationError(`A ${request.status} quotation cannot be edited`);
  const totals = buildTotals(input);
  const validUntil = cleanDate(input.validUntil);
  if (input.fileId) {
    const file = getCustomerFile(input.fileId, db, accountId);
    if (!file || file.direction !== 'outbound' || (file.customer_id !== null && file.customer_id !== request.customer_id) || file.status !== 'stored') {
      throw new QuotationError('That file cannot be attached to this quotation', 400);
    }
  }
  const versionId = db.transaction((): number => {
    const draft = db.prepare(`SELECT id FROM quotation_versions WHERE request_id = ? AND state = 'draft'`).get(requestId) as { id: number } | undefined;
    const fields = {
      currency: totals.currency, validUntil, subtotal: totals.subtotal, taxBp: totals.taxBp, tax: totals.tax, total: totals.total,
      message: cleanText(input.customerMessage, 2000), note: cleanText(input.internalNote, 2000), fileId: input.fileId ?? null,
      adminId: actor.adminId ?? null, name: actor.name?.slice(0, 100) ?? null,
    };
    let id: number;
    if (draft) {
      id = draft.id;
      db.prepare(
        `UPDATE quotation_versions SET currency=@currency, valid_until=@validUntil, subtotal_minor=@subtotal, tax_rate_bp=@taxBp, tax_minor=@tax, total_minor=@total,
           customer_message=@message, internal_note=@note, file_id=@fileId, prepared_by_admin_id=@adminId, prepared_by_name=@name, updated_at=datetime('now') WHERE id=@id`,
      ).run({ ...fields, id });
      db.prepare('DELETE FROM quotation_lines WHERE version_id = ?').run(id);
    } else {
      const next = ((db.prepare('SELECT MAX(version) AS v FROM quotation_versions WHERE request_id = ?').get(requestId) as { v: number | null }).v ?? 0) + 1;
      const result = db
        .prepare(
          `INSERT INTO quotation_versions (whatsapp_account_id, request_id, customer_id, version, quote_number, state, currency, valid_until, subtotal_minor, tax_rate_bp, tax_minor, total_minor,
             customer_message, internal_note, file_id, prepared_by_admin_id, prepared_by_name)
           VALUES (@accountId, @requestId, @customerId, @version, @quoteNumber, 'draft', @currency, @validUntil, @subtotal, @taxBp, @tax, @total, @message, @note, @fileId, @adminId, @name)`,
        )
        .run({ ...fields, accountId, requestId, customerId: request.customer_id, version: next, quoteNumber: `${request.reference}-Q${next}` });
      id = Number(result.lastInsertRowid);
    }
    const insert = db.prepare('INSERT INTO quotation_lines (version_id, position, description, quantity_milli, unit_price_minor, line_total_minor) VALUES (?, ?, ?, ?, ?, ?)');
    totals.lines.forEach((l, i) => insert.run(id, i + 1, l.description, l.quantity_milli, l.unit_price_minor, l.line_total_minor));
    if (input.fileId) linkFileToRequest(input.fileId, requestId, id, db, accountId);
    return id;
  })();
  if (request.status === 'pending' || request.status === 'contacted') {
    changeRequestStatus(requestId, 'preparing', { type: 'dashboard', detail: actorDetail(actor) }, db, accountId, { adminUserId: actor.adminId ?? null, reason: 'Quotation draft started' });
  }
  return getVersion(versionId, db, accountId)!;
}

/** Freezes the draft: from now on it is the quotation that can be sent, and it can no longer be edited. */
export function finalizeVersion(requestId: number, versionId: number, actor: StaffActor, db: Database.Database = getDb(), accountId: number = currentAccountId()): QuotationVersion {
  requireQuotation(requestId, db, accountId);
  const version = getVersion(versionId, db, accountId);
  if (!version || version.request_id !== requestId) throw new QuotationError('Quotation version not found', 404);
  if (version.state !== 'draft') throw new QuotationError('Only a draft can be finalised');
  const lines = versionLines(versionId, db);
  if (lines.length === 0 && !version.customer_message && !version.file_id) throw new QuotationError('Add at least one line, a message or a file before finalising', 400);
  db.transaction(() => {
    db.prepare(`UPDATE quotation_versions SET state = 'superseded', updated_at = datetime('now') WHERE request_id = ? AND state = 'final'`).run(requestId);
    db.prepare(`UPDATE quotation_versions SET state = 'final', finalized_at = datetime('now'), updated_at = datetime('now'), prepared_by_admin_id = COALESCE(@adminId, prepared_by_admin_id) WHERE id = @id`).run({ id: versionId, adminId: actor.adminId ?? null });
  })();
  return getVersion(versionId, db, accountId)!;
}

export function approveQuotation(requestId: number, actor: StaffActor, db: Database.Database = getDb(), accountId: number = currentAccountId()): StatusChangeResult {
  requireQuotation(requestId, db, accountId);
  return changeRequestStatus(requestId, 'approved', { type: 'dashboard', detail: actorDetail(actor) }, db, accountId, { adminUserId: actor.adminId ?? null })!;
}

export function rejectQuotation(requestId: number, reason: string, actor: StaffActor, db: Database.Database = getDb(), accountId: number = currentAccountId()): StatusChangeResult {
  requireQuotation(requestId, db, accountId);
  const why = cleanText(reason, 500);
  if (!why || why.length < 3) throw new QuotationError('A reason is required to reject a quotation', 400);
  return changeRequestStatus(requestId, 'rejected', { type: 'dashboard', detail: actorDetail(actor) }, db, accountId, { adminUserId: actor.adminId ?? null, reason: why })!;
}

// ---------------------------------------------------------------- the text the customer receives

function dateLabel(iso: string): string {
  return iso;
}

/** The quotation as WhatsApp text, in the customer's language: only what was supplied. Internal notes never appear. */
export function renderQuotationText(version: QuotationVersion, lines: QuotationLine[], language: 'ar' | 'en'): string {
  const ar = language === 'ar';
  const out: string[] = [];
  const cur = version.currency;
  lines.forEach((l) => {
    const parts = [`${l.position}. ${l.description}`];
    if (l.quantity_milli !== null) parts.push(`${ar ? 'الكمية' : 'Qty'}: ${formatQuantity(l.quantity_milli)}`);
    if (l.unit_price_minor !== null) parts.push(`${ar ? 'السعر' : 'Price'}: ${formatMoney(l.unit_price_minor, cur)}`);
    if (l.line_total_minor !== null && l.unit_price_minor !== null) parts.push(`${ar ? 'الإجمالي' : 'Line total'}: ${formatMoney(l.line_total_minor, cur)}`);
    out.push(parts.join(' — '));
  });
  const money: string[] = [];
  if (version.subtotal_minor !== null && (version.tax_minor !== null || lines.length > 1)) money.push(`${ar ? 'المجموع الفرعي' : 'Subtotal'}: ${formatMoney(version.subtotal_minor, cur)}`);
  if (version.tax_minor !== null && version.tax_rate_bp !== null) {
    const rate = version.tax_rate_bp % 100 === 0 ? String(version.tax_rate_bp / 100) : (version.tax_rate_bp / 100).toFixed(2);
    money.push(`${ar ? 'الضريبة' : 'Tax'} (${rate}%): ${formatMoney(version.tax_minor, cur)}`);
  }
  if (version.total_minor !== null) money.push(`${ar ? 'الإجمالي' : 'Total'}: ${formatMoney(version.total_minor, cur)}`);
  const blocks = [out.join('\n'), money.join('\n')];
  if (version.valid_until) blocks.push(`${ar ? 'صالح حتى' : 'Valid until'}: ${dateLabel(version.valid_until)}`);
  if (version.customer_message) blocks.push(version.customer_message);
  return blocks.filter(Boolean).join('\n\n');
}

/** Customer-safe summary of the quotation they were actually sent, for their status check. Nothing before delivery, nothing internal. */
export function sentQuotationSummary(requestId: number, language: 'ar' | 'en', db: Database.Database = getDb(), accountId: number = currentAccountId()): string {
  const sent = listVersions(requestId, db, accountId).filter((v) => v.sent_at).pop();
  if (!sent) return '';
  return `${sent.quote_number}\n${renderQuotationText(sent, versionLines(sent.id, db), language)}`;
}

// ---------------------------------------------------------------- sending

/**
 * Queues the delivery of the current final version. Requires an APPROVED request (approval is not delivery) and a finalised version.
 * Idempotent per version: asking twice returns the same queued row. The request becomes "sent" only after WhatsApp accepts the message.
 */
export function sendQuotation(requestId: number, actor: StaffActor, db: Database.Database = getDb(), accountId: number = currentAccountId()): { version: QuotationVersion; outbox: OutboxRow; alreadyQueued: boolean } {
  const request = requireQuotation(requestId, db, accountId);
  if (request.status !== 'approved') throw new QuotationError(request.status === 'sent' ? 'This quotation was already sent. Prepare a new version to send a revision.' : 'Approve the quotation before sending it');
  const version = listVersions(requestId, db, accountId).filter((v) => v.state === 'final').pop();
  if (!version) throw new QuotationError('Finalise a quotation version before sending it');
  const customer = getCustomerById(request.customer_id, db, null);
  if (!customer) throw new QuotationError('The customer record is missing', 404);
  return runWithAccount(accountId, () => {
    const language = (customer.language ?? 'en') as 'ar' | 'en';
    const text = renderQuotationText(version, versionLines(version.id, db), language);
    const body = resolveTemplate('quotation_delivery', language, { ...requestTemplateVars(request, customer, language), reference: version.quote_number, details: text }, db, accountId);
    const { row, created } = enqueueNotification(
      { kind: 'customer_quotation', requestId, targetJid: customerNotificationJid(customer), body, dedupeKey: `quotation:${version.id}:send`, accountId, attachmentFileId: version.file_id },
      db,
    );
    if (created) {
      db.prepare('UPDATE quotation_versions SET sent_outbox_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(row.id, version.id);
      insertRequestEvent({ requestId, reference: request.reference, oldStatus: request.status, newStatus: request.status, actor: 'dashboard', actorDetail: actorDetail(actor), adminUserId: actor.adminId ?? null, reason: `Quotation ${version.quote_number} queued for delivery` }, db);
      kickOutbox();
    }
    return { version: getVersion(version.id, db, accountId)!, outbox: row, alreadyQueued: !created };
  });
}

/** Staff delivered the quotation by other means (a call, an email): recorded with a mandatory reason, never silently. */
export function markQuotationSentManually(requestId: number, reason: string, actor: StaffActor, db: Database.Database = getDb(), accountId: number = currentAccountId()): StatusChangeResult {
  const request = requireQuotation(requestId, db, accountId);
  const why = cleanText(reason, 500);
  if (!why || why.length < 3) throw new QuotationError('Say how it was sent (a reason is required)', 400);
  if (request.status !== 'approved') throw new QuotationError('Approve the quotation first');
  const version = listVersions(requestId, db, accountId).filter((v) => v.state === 'final').pop();
  if (!version) throw new QuotationError('Finalise a quotation version first');
  db.prepare(`UPDATE quotation_versions SET sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND sent_at IS NULL`).run(version.id);
  return changeRequestStatus(requestId, 'sent', { type: 'dashboard', detail: actorDetail(actor) }, db, accountId, { adminUserId: actor.adminId ?? null, reason: `Sent outside WhatsApp: ${why}`, allowSent: true })!;
}

/**
 * The delivery outcome of a quotation message. Registered with the outbox (see qrConnection / tests). Delivered → the version records
 * its send time and the request becomes "sent" (idempotent). Permanently failed → an audit event says so; the request stays approved
 * and staff can retry the delivery.
 */
export function handleQuotationOutcome(row: OutboxRow, outcome: 'delivered' | 'failed', db: Database.Database = getDb()): void {
  if (row.kind !== 'customer_quotation' || row.request_id === null) return;
  const version = db.prepare('SELECT * FROM quotation_versions WHERE sent_outbox_id = ? AND whatsapp_account_id = ?').get(row.id, row.whatsapp_account_id) as QuotationVersion | undefined;
  const request = getCustomerRequest(row.request_id, db, null);
  if (!version || !request) return;
  runWithAccount(row.whatsapp_account_id, () => {
    if (outcome === 'delivered') {
      db.prepare(`UPDATE quotation_versions SET sent_at = COALESCE(sent_at, datetime('now')), updated_at = datetime('now') WHERE id = ?`).run(version.id);
      changeRequestStatus(request.id, 'sent', { type: 'system', detail: 'delivered through WhatsApp' }, db, null, { reason: `Quotation ${version.quote_number} delivered (message ${row.message_id ?? 'n/a'})`, allowSent: true });
    } else {
      insertRequestEvent({ requestId: request.id, reference: request.reference, oldStatus: request.status, newStatus: request.status, actor: 'system', actorDetail: 'delivery', reason: `Quotation ${version.quote_number} could not be delivered: ${row.last_error ?? 'unknown error'}` }, db);
      logger.warn({ reference: request.reference, outbox: row.id }, '[QUOTATION] delivery failed permanently');
    }
  });
}

export interface QuotationView {
  versions: (QuotationVersion & { lines: QuotationLine[]; preview: string })[];
  deliveries: OutboxRow[];
}

/** Everything staff see for a quotation: all versions with lines, and the delivery attempts. */
export function quotationView(requestId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): QuotationView {
  const request = requireQuotation(requestId, db, accountId);
  const customer = getCustomerById(request.customer_id, db, null);
  const language = (customer?.language ?? 'en') as 'ar' | 'en';
  return {
    versions: listVersions(requestId, db, accountId).map((v) => {
      const lines = versionLines(v.id, db);
      return { ...v, lines, preview: renderQuotationText(v, lines, language) };
    }),
    deliveries: listOutbox({ requestId, accountId }, db).filter((o) => o.kind === 'customer_quotation'),
  };
}

export { MoneyError };
