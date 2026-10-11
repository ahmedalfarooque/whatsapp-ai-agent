import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { REQUEST_STATUSES } from '../memory/customerRequestRepo';
import { normalizeBoundary } from './customerProfile';

/**
 * Customer directory and Customer Reports for ONE business. Every figure is computed from the records that already exist (customers,
 * requests, quotation versions, carts, files, notes) and every metric is defined in METRIC_DEFINITIONS, which the dashboard shows
 * beside the numbers so nobody has to guess what "active" or "open" means. Nothing is estimated and nothing is sampled: a customer
 * counted in a total is a customer you can open from the directory with the same filters.
 */

export const OPEN_REQUEST_STATUSES = ['pending', 'preparing', 'contacted', 'approved'] as const;

export const METRIC_DEFINITIONS: Record<string, string> = {
  totalCustomers: 'Everyone who has ever written to this business on WhatsApp (all time).',
  newCustomers: 'Customers whose first contact was inside the selected dates.',
  activeCustomers: 'Customers with at least one WhatsApp message (sent or received) inside the selected dates.',
  customersWithInquiries: 'Customers who created at least one quotation or appointment request inside the selected dates.',
  inquiries: 'Quotation requests created inside the selected dates (from the menu or the Inquiry Cart).',
  appointmentRequests: 'Appointment requests created inside the selected dates.',
  quotationsByStatus: 'Quotation requests created inside the selected dates, grouped by their status today. Approved means staff decided to quote; Sent means the quotation was actually delivered.',
  quotationsSent: 'Quotation versions delivered to customers inside the selected dates (a revision counts again).',
  awaitingSend: 'Quotation requests that are Approved today but not yet delivered (not date-limited).',
  openRequests: 'Requests in Pending, Preparing, Contacted or Approved today (not date-limited): work still waiting for staff.',
  cartsSubmitted: 'Inquiry carts submitted by customers inside the selected dates.',
  openCarts: 'Inquiry carts with items that were not submitted yet (not date-limited).',
  staleCarts: 'Open carts not touched for 7 days or more (not date-limited).',
  documentsReceived: 'Files customers sent inside the selected dates that were stored.',
  documentsSent: 'Files sent to customers (for example quotation documents) inside the selected dates.',
  filesNeedingReview: 'Files that could not be tied to a customer for certain, or could not be stored (not date-limited): staff decide.',
  followUpsOutstanding: 'Follow-ups staff scheduled that are not marked done (not date-limited).',
  followUpsOverdue: 'Outstanding follow-ups whose date has passed (not date-limited).',
};

export interface ReportRange {
  from?: string;
  to?: string;
}

function range(params: ReportRange): { from: string; to: string } {
  const from = params.from ? normalizeBoundary(params.from, false) : '';
  const to = params.to ? normalizeBoundary(params.to, true) : '';
  return { from: from || '0000-01-01 00:00:00', to: to || '9999-12-31 23:59:59' };
}

export interface ReportSummary {
  range: ReportRange;
  metrics: {
    totalCustomers: number;
    newCustomers: number;
    activeCustomers: number;
    customersWithInquiries: number;
    inquiries: number;
    appointmentRequests: number;
    quotationsByStatus: Record<string, number>;
    quotationsSent: number;
    awaitingSend: number;
    openRequests: number;
    cartsSubmitted: number;
    openCarts: number;
    staleCarts: number;
    documentsReceived: number;
    documentsSent: number;
    filesNeedingReview: number;
    followUpsOutstanding: number;
    followUpsOverdue: number;
  };
  definitions: Record<string, string>;
}

export function reportSummary(params: ReportRange = {}, db: Database.Database = getDb(), accountId: number = currentAccountId()): ReportSummary {
  const { from, to } = range(params);
  const n = (sql: string, extra: Record<string, unknown> = {}): number => (db.prepare(sql).get({ accountId, from, to, ...extra }) as { n: number }).n;
  const byStatus: Record<string, number> = {};
  for (const r of db
    .prepare(`SELECT status, COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id = @accountId AND kind = 'quotation' AND created_at BETWEEN @from AND @to GROUP BY status`)
    .all({ accountId, from, to }) as { status: string; n: number }[]) byStatus[r.status] = r.n;
  for (const s of REQUEST_STATUSES) if (byStatus[s] === undefined && ['pending', 'preparing', 'approved', 'sent', 'rejected', 'cancelled', 'expired', 'completed', 'closed'].includes(s)) byStatus[s] = 0;
  const open = OPEN_REQUEST_STATUSES.map((s) => `'${s}'`).join(',');
  return {
    range: { from: params.from, to: params.to },
    metrics: {
      totalCustomers: n('SELECT COUNT(*) AS n FROM customers WHERE whatsapp_account_id = @accountId'),
      newCustomers: n('SELECT COUNT(*) AS n FROM customers WHERE whatsapp_account_id = @accountId AND created_at BETWEEN @from AND @to'),
      activeCustomers: n(
        `SELECT COUNT(DISTINCT c.customer_id) AS n FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.whatsapp_account_id = @accountId AND m.created_at BETWEEN @from AND @to AND m.role IN ('user', 'assistant')`,
      ),
      customersWithInquiries: n(`SELECT COUNT(DISTINCT customer_id) AS n FROM customer_requests WHERE whatsapp_account_id = @accountId AND created_at BETWEEN @from AND @to`),
      inquiries: n(`SELECT COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id = @accountId AND kind = 'quotation' AND created_at BETWEEN @from AND @to`),
      appointmentRequests: n(`SELECT COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id = @accountId AND kind = 'appointment' AND created_at BETWEEN @from AND @to`),
      quotationsByStatus: byStatus,
      quotationsSent: n(`SELECT COUNT(*) AS n FROM quotation_versions WHERE whatsapp_account_id = @accountId AND sent_at BETWEEN @from AND @to`),
      awaitingSend: n(`SELECT COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id = @accountId AND kind = 'quotation' AND status = 'approved'`),
      openRequests: n(`SELECT COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id = @accountId AND status IN (${open})`),
      cartsSubmitted: n(`SELECT COUNT(*) AS n FROM inquiry_carts WHERE whatsapp_account_id = @accountId AND submitted_at BETWEEN @from AND @to`),
      openCarts: n(`SELECT COUNT(*) AS n FROM inquiry_carts c WHERE c.whatsapp_account_id = @accountId AND c.status = 'open' AND EXISTS (SELECT 1 FROM inquiry_cart_items i WHERE i.cart_id = c.id AND i.removed_at IS NULL)`),
      staleCarts: n(`SELECT COUNT(*) AS n FROM inquiry_carts c WHERE c.whatsapp_account_id = @accountId AND c.status = 'open' AND c.updated_at < datetime('now', '-7 days') AND EXISTS (SELECT 1 FROM inquiry_cart_items i WHERE i.cart_id = c.id AND i.removed_at IS NULL)`),
      documentsReceived: n(`SELECT COUNT(*) AS n FROM customer_files WHERE whatsapp_account_id = @accountId AND direction = 'inbound' AND status IN ('stored', 'needs_review') AND created_at BETWEEN @from AND @to`),
      documentsSent: n(`SELECT COUNT(*) AS n FROM customer_files WHERE whatsapp_account_id = @accountId AND direction = 'outbound' AND created_at BETWEEN @from AND @to`),
      filesNeedingReview: n(`SELECT COUNT(*) AS n FROM customer_files WHERE whatsapp_account_id = @accountId AND (customer_id IS NULL OR status IN ('needs_review', 'failed', 'too_large', 'unsupported'))`),
      followUpsOutstanding: n(`SELECT COUNT(*) AS n FROM customer_notes WHERE whatsapp_account_id = @accountId AND follow_up_at IS NOT NULL AND follow_up_done_at IS NULL`),
      followUpsOverdue: n(`SELECT COUNT(*) AS n FROM customer_notes WHERE whatsapp_account_id = @accountId AND follow_up_at IS NOT NULL AND follow_up_done_at IS NULL AND follow_up_at < datetime('now')`),
    },
    definitions: METRIC_DEFINITIONS,
  };
}

// ---------------------------------------------------------------- directory

export interface DirectoryParams extends ReportRange {
  search?: string;
  language?: 'ar' | 'en';
  /** Only customers who have a request in this status (today). */
  requestStatus?: string;
  /** Only customers with work still open (Pending / Preparing / Contacted / Approved). */
  openOnly?: boolean;
  hasFiles?: boolean;
  followUp?: 'outstanding' | 'overdue';
  sort?: 'recent' | 'name' | 'inquiries';
  limit?: number;
  offset?: number;
}

export interface DirectoryRow {
  id: number;
  wa_id: string;
  display_name: string | null;
  email: string | null;
  company_name: string | null;
  language: string | null;
  created_at: string;
  lastInteractionAt: string | null;
  inquiries: number;
  appointments: number;
  openRequests: number;
  quotationsSent: number;
  files: number;
  openCart: number;
  nextFollowUpAt: string | null;
}

function directoryWhere(params: DirectoryParams, accountId: number): { where: string; args: Record<string, unknown> } {
  const clauses = ['cu.whatsapp_account_id = @accountId'];
  const args: Record<string, unknown> = { accountId };
  const search = params.search?.trim();
  if (search) {
    clauses.push(`(cu.wa_id LIKE @term ESCAPE '\\' OR cu.display_name LIKE @term ESCAPE '\\' OR cu.email LIKE @term ESCAPE '\\' OR cu.company_name LIKE @term ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM customer_requests rs WHERE rs.customer_id = cu.id AND rs.reference LIKE @term ESCAPE '\\'))`);
    args.term = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  }
  if (params.language === 'ar' || params.language === 'en') {
    clauses.push('cu.language = @language');
    args.language = params.language;
  }
  if (params.from || params.to) {
    const { from, to } = range(params);
    args.from = from;
    args.to = to;
    clauses.push(`(EXISTS (SELECT 1 FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.customer_id = cu.id AND m.created_at BETWEEN @from AND @to)
      OR EXISTS (SELECT 1 FROM customer_requests rr WHERE rr.customer_id = cu.id AND rr.created_at BETWEEN @from AND @to))`);
  }
  if (params.requestStatus && (REQUEST_STATUSES as readonly string[]).includes(params.requestStatus)) {
    clauses.push('EXISTS (SELECT 1 FROM customer_requests rq WHERE rq.customer_id = cu.id AND rq.status = @requestStatus)');
    args.requestStatus = params.requestStatus;
  }
  if (params.openOnly) clauses.push(`EXISTS (SELECT 1 FROM customer_requests ro WHERE ro.customer_id = cu.id AND ro.status IN (${OPEN_REQUEST_STATUSES.map((s) => `'${s}'`).join(',')}))`);
  if (params.hasFiles) clauses.push('EXISTS (SELECT 1 FROM customer_files f WHERE f.customer_id = cu.id)');
  if (params.followUp) {
    clauses.push(`EXISTS (SELECT 1 FROM customer_notes n WHERE n.customer_id = cu.id AND n.follow_up_at IS NOT NULL AND n.follow_up_done_at IS NULL${params.followUp === 'overdue' ? " AND n.follow_up_at < datetime('now')" : ''})`);
  }
  return { where: `WHERE ${clauses.join(' AND ')}`, args };
}

export function listDirectory(params: DirectoryParams = {}, db: Database.Database = getDb(), accountId: number = currentAccountId()): { items: DirectoryRow[]; total: number } {
  const { where, args } = directoryWhere(params, accountId);
  const limit = Math.max(1, Math.min(params.limit ?? 25, 100));
  const offset = Math.max(0, params.offset ?? 0);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM customers cu ${where}`).get(args) as { n: number }).n;
  const order = params.sort === 'name' ? 'COALESCE(cu.display_name, cu.wa_id) COLLATE NOCASE ASC' : params.sort === 'inquiries' ? 'inquiries DESC, COALESCE(lastInteractionAt, cu.created_at) DESC' : 'COALESCE(lastInteractionAt, cu.created_at) DESC';
  const items = db
    .prepare(
      `SELECT cu.id, cu.wa_id, cu.display_name, cu.email, cu.company_name, cu.language, cu.created_at,
         (SELECT MAX(m.created_at) FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.customer_id = cu.id) AS lastInteractionAt,
         (SELECT COUNT(*) FROM customer_requests r WHERE r.customer_id = cu.id AND r.kind = 'quotation') AS inquiries,
         (SELECT COUNT(*) FROM customer_requests r WHERE r.customer_id = cu.id AND r.kind = 'appointment') AS appointments,
         (SELECT COUNT(*) FROM customer_requests r WHERE r.customer_id = cu.id AND r.status IN (${OPEN_REQUEST_STATUSES.map((s) => `'${s}'`).join(',')})) AS openRequests,
         (SELECT COUNT(*) FROM quotation_versions v WHERE v.customer_id = cu.id AND v.sent_at IS NOT NULL) AS quotationsSent,
         (SELECT COUNT(*) FROM customer_files f WHERE f.customer_id = cu.id) AS files,
         (SELECT COUNT(*) FROM inquiry_carts ic WHERE ic.customer_id = cu.id AND ic.status = 'open') AS openCart,
         (SELECT MIN(n.follow_up_at) FROM customer_notes n WHERE n.customer_id = cu.id AND n.follow_up_at IS NOT NULL AND n.follow_up_done_at IS NULL) AS nextFollowUpAt
       FROM customers cu ${where} ORDER BY ${order} LIMIT @limit OFFSET @offset`,
    )
    .all({ ...args, limit, offset }) as DirectoryRow[];
  return { items, total };
}

// ---------------------------------------------------------------- CSV export (authorized records of this business only)

/** A spreadsheet treats a cell starting with = + - @ as a formula: prefix it so customer-supplied text can never run as one. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  // The BOM makes Excel read Arabic (UTF-8) correctly.
  const BOM = String.fromCharCode(0xfeff);
  return `${BOM}${[headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export const EXPORT_ROW_LIMIT = 5000;

/** Every customer the directory shows for these filters (the same query, paged), up to the export limit. 	otal is the real count. */
export function allDirectoryRows(params: DirectoryParams, db: Database.Database = getDb(), accountId: number = currentAccountId()): { rows: DirectoryRow[]; total: number; truncated: boolean } {
  const rows: DirectoryRow[] = [];
  let total = 0;
  for (let offset = 0; offset < EXPORT_ROW_LIMIT; offset += 100) {
    const page = listDirectory({ ...params, limit: 100, offset }, db, accountId);
    total = page.total;
    rows.push(...page.items);
    if (page.items.length < 100) break;
  }
  return { rows, total, truncated: total > rows.length };
}

export function exportCustomersCsv(params: DirectoryParams, db: Database.Database = getDb(), accountId: number = currentAccountId()): string {
  const { rows } = allDirectoryRows(params, db, accountId);
  return toCsv(
    ['Customer ID', 'WhatsApp number', 'Name', 'Company', 'Email', 'Language', 'First contact', 'Last interaction', 'Inquiries', 'Appointments', 'Open requests', 'Quotations sent', 'Files', 'Open cart', 'Next follow-up'],
    rows.map((r) => [r.id, r.wa_id, r.display_name, r.company_name, r.email, r.language, r.created_at, r.lastInteractionAt, r.inquiries, r.appointments, r.openRequests, r.quotationsSent, r.files, r.openCart ? 'yes' : 'no', r.nextFollowUpAt]),
  );
}

export interface QuotationExportRow {
  reference: string; status: string; source: string; created_at: string; updated_at: string; wa_id: string; display_name: string | null; company_name: string | null;
  quote_number: string | null; total_minor: number | null; currency: string | null; sent_at: string | null;
}

/** The quotation requests created inside the dates (this business only), newest first, with the latest quotation's number and total. */
export function quotationExportRows(params: ReportRange, db: Database.Database = getDb(), accountId: number = currentAccountId()): { rows: QuotationExportRow[]; total: number; truncated: boolean } {
  const { from, to } = range(params);
  const rows = db
    .prepare(
      `SELECT r.reference, r.status, r.source, r.created_at, r.updated_at, cu.wa_id, cu.display_name, cu.company_name,
         (SELECT v.quote_number FROM quotation_versions v WHERE v.request_id = r.id ORDER BY v.version DESC LIMIT 1) AS quote_number,
         (SELECT v.total_minor FROM quotation_versions v WHERE v.request_id = r.id ORDER BY v.version DESC LIMIT 1) AS total_minor,
         (SELECT v.currency FROM quotation_versions v WHERE v.request_id = r.id ORDER BY v.version DESC LIMIT 1) AS currency,
         (SELECT v.sent_at FROM quotation_versions v WHERE v.request_id = r.id AND v.sent_at IS NOT NULL ORDER BY v.version DESC LIMIT 1) AS sent_at
       FROM customer_requests r JOIN customers cu ON cu.id = r.customer_id
       WHERE r.whatsapp_account_id = @accountId AND r.kind = 'quotation' AND r.created_at BETWEEN @from AND @to ORDER BY r.created_at DESC, r.id DESC LIMIT ${EXPORT_ROW_LIMIT}`,
    )
    .all({ accountId, from, to }) as QuotationExportRow[];
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id = @accountId AND kind = 'quotation' AND created_at BETWEEN @from AND @to`).get({ accountId, from, to }) as { n: number }).n;
  return { rows, total, truncated: total > rows.length };
}

export function exportQuotationsCsv(params: ReportRange, db: Database.Database = getDb(), accountId: number = currentAccountId()): string {
  const { rows } = quotationExportRows(params, db, accountId);
  return toCsv(
    ['Reference', 'Status', 'Source', 'Created', 'Updated', 'WhatsApp number', 'Customer', 'Company', 'Latest quotation', 'Total', 'Currency', 'Sent at'],
    rows.map((r) => [r.reference, r.status, r.source, r.created_at, r.updated_at, r.wa_id, r.display_name, r.company_name, r.quote_number, r.total_minor === null ? '' : (r.total_minor / 100).toFixed(2), r.currency, r.sent_at]),
  );
}
