import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { logger, maskWaId } from '../logger';
import { getBusinessSettings } from '../config/businessSettings';
import { getQrSession } from '../memory/qrSessionRepo';
import { getCustomerById, type Customer } from '../memory/customerRepo';
import { getLidForPn, canonicalJid } from '../memory/lidMapRepo';
import {
  getCustomerRequest,
  getCustomerRequestByReference,
  setCustomerRequestStatus,
  insertRequestEvent,
  listRequestEvents,
  REQUEST_STATUSES,
  type CustomerRequest,
  type CustomerRequestStatus,
  type RequestEvent,
} from '../memory/customerRequestRepo';
import { resolveTemplate, type TemplateVars } from '../templates/templateRepo';
import { enqueueNotification, flushOutbox, listOutbox, type OutboxRow } from '../notifications/outbox';

/**
 * One source of truth for appointment / quotation status. Every transition —
 * from the dashboard, from a WhatsApp operator command, or from the system —
 * goes through changeRequestStatus(): it is idempotent, writes an audit
 * event, and queues the customer / staff notifications exactly once per
 * (request, status). Messages leave through the outbox, never inline.
 */

export type RequestActor = { type: 'dashboard' | 'whatsapp' | 'system'; detail?: string };

const CUSTOMER_TEMPLATE: Partial<Record<CustomerRequestStatus, string>> = {
  confirmed: 'request_confirmed',
  rejected: 'request_rejected',
  cancelled: 'request_cancelled',
  contacted: 'request_status_update',
  completed: 'request_status_update',
};

const STATUS_LABEL: Record<CustomerRequestStatus, { en: string; ar: string }> = {
  pending: { en: 'Pending', ar: 'قيد الانتظار' },
  contacted: { en: 'Contacted', ar: 'تم التواصل' },
  confirmed: { en: 'Confirmed', ar: 'مؤكد' },
  rejected: { en: 'Rejected', ar: 'مرفوض' },
  cancelled: { en: 'Cancelled', ar: 'ملغي' },
  completed: { en: 'Completed', ar: 'مكتمل' },
  closed: { en: 'Closed', ar: 'مغلق' },
};

const KIND_LABEL = { appointment: { en: 'Appointment', ar: 'موعد' }, quotation: { en: 'Quotation', ar: 'عرض سعر' } } as const;

const FIELD_LABEL: Record<string, { en: string; ar: string }> = {
  name: { en: 'Name', ar: 'الاسم' }, make: { en: 'Vehicle make', ar: 'ماركة السيارة' }, model: { en: 'Vehicle model', ar: 'الموديل' },
  year: { en: 'Year', ar: 'سنة الصنع' }, service: { en: 'Service', ar: 'الخدمة' }, date: { en: 'Requested date', ar: 'التاريخ المطلوب' },
  time: { en: 'Requested time', ar: 'الوقت المطلوب' }, notes: { en: 'Notes', ar: 'ملاحظات' }, vehicle: { en: 'Vehicle', ar: 'السيارة' },
};

export function statusLabel(status: CustomerRequestStatus, language: 'ar' | 'en'): string {
  return STATUS_LABEL[status]?.[language] ?? status;
}

/** Placeholder values for request templates ({reference} {name} {service} {date} {time} {details} {customer} {status} {kind}). */
export function requestTemplateVars(request: CustomerRequest, customer: Customer | undefined, language: 'ar' | 'en', extra: Partial<TemplateVars> = {}): TemplateVars {
  const p = request.payload;
  const vehicle = p.vehicle ?? [p.make, p.model, p.year].filter(Boolean).join(' ');
  const details = Object.entries(p)
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `${FIELD_LABEL[k]?.[language] ?? k}: ${v}`)
    .join('\n');
  return {
    reference: request.reference,
    name: p.name || customer?.display_name || '',
    service: p.service ?? '',
    date: p.date ?? '',
    time: p.time ?? '',
    vehicle,
    details,
    customer: customer ? maskWaId(customer.wa_id) : '',
    status: statusLabel(request.status, language),
    kind: KIND_LABEL[request.kind][language],
    language,
    ...extra,
  };
}

/** Where a customer's notification goes: the chat they last wrote from (may be @lid) — never a rewritten address. */
export function customerNotificationJid(customer: Customer): string {
  if (customer.reply_jid) return customer.reply_jid;
  const pn = `${customer.wa_id}@s.whatsapp.net`;
  return getLidForPn(pn) ?? pn;
}

/** Where staff alerts go: the configured staff number, else the linked business number's own chat. */
export function businessNotificationJid(db: Database.Database = getDb()): string | null {
  const settings = getBusinessSettings();
  const staff = settings.staffWhatsappNumber?.replace(/[^\d]/g, '');
  if (staff) return `${staff}@s.whatsapp.net`;
  const session = getQrSession(db);
  return session.jid ? canonicalJid(session.jid) : null;
}

function kick(): void {
  void flushOutbox().catch((error) => logger.warn({ error }, '[OUTBOX] flush failed'));
}

/** Queues the staff alert for a freshly created request (idempotent per request). */
export function notifyBusinessNewRequest(request: CustomerRequest, db: Database.Database = getDb()): OutboxRow | null {
  const target = businessNotificationJid(db);
  if (!target) {
    logger.warn({ reference: request.reference }, 'no business WhatsApp number linked — staff alert not queued');
    return null;
  }
  const customer = getCustomerById(request.customer_id, db);
  const body = resolveTemplate('staff_new_request', 'en', requestTemplateVars(request, customer, 'en'), db);
  const { row } = enqueueNotification({ kind: 'business_new_request', requestId: request.id, targetJid: target, body, dedupeKey: `business:new:${request.id}` }, db);
  kick();
  return row;
}

export interface StatusChangeResult {
  request: CustomerRequest;
  changed: boolean;
  event: RequestEvent | null;
  notifications: OutboxRow[];
}

export function isRequestStatus(value: unknown): value is CustomerRequestStatus {
  return typeof value === 'string' && (REQUEST_STATUSES as readonly string[]).includes(value);
}

/**
 * Idempotent status transition. Same status → no event, no notification.
 * Customer notification keyed by (request, status) so a status is announced
 * to the customer at most once, even if staff flip back and forth.
 */
export function changeRequestStatus(
  id: number,
  newStatus: CustomerRequestStatus,
  actor: RequestActor,
  db: Database.Database = getDb(),
): StatusChangeResult | undefined {
  const current = getCustomerRequest(id, db);
  if (!current) return undefined;
  if (current.status === newStatus) return { request: current, changed: false, event: null, notifications: [] };

  const updated = setCustomerRequestStatus(id, newStatus, db)!;
  const event = insertRequestEvent({ requestId: id, reference: updated.reference, oldStatus: current.status, newStatus, actor: actor.type, actorDetail: actor.detail ?? null }, db);
  const notifications: OutboxRow[] = [];
  const customer = getCustomerById(updated.customer_id, db);

  const templateKey = CUSTOMER_TEMPLATE[newStatus];
  if (templateKey && customer) {
    const language = (customer.language ?? 'en') as 'ar' | 'en';
    const body = resolveTemplate(templateKey, language, requestTemplateVars(updated, customer, language), db);
    const { row, created } = enqueueNotification(
      { kind: 'customer_status', requestId: id, targetJid: customerNotificationJid(customer), body, dedupeKey: `customer:${id}:${newStatus}` },
      db,
    );
    if (created) notifications.push(row);
  }

  if (actor.type !== 'whatsapp') {
    const target = businessNotificationJid(db);
    if (target) {
      const body = resolveTemplate('staff_status_changed', 'en', requestTemplateVars(updated, customer, 'en', { actor: actor.type === 'dashboard' ? 'Dashboard' : 'System' }), db);
      const { row, created } = enqueueNotification(
        { kind: 'business_status', requestId: id, targetJid: target, body, dedupeKey: `business:status:${id}:${event.id}` },
        db,
      );
      if (created) notifications.push(row);
    }
  }
  logger.info({ reference: updated.reference, from: current.status, to: newStatus, actor: actor.type, queued: notifications.length }, '[REQUEST] status changed');
  kick();
  return { request: updated, changed: true, event, notifications };
}

// ------------------------------------------------------------------ operator commands (from the business WhatsApp account)

const COMMANDS: Record<string, CustomerRequestStatus> = {
  confirm: 'confirmed', confirmed: 'confirmed', 'تأكيد': 'confirmed', 'اكد': 'confirmed', 'أكد': 'confirmed',
  reject: 'rejected', rejected: 'rejected', 'رفض': 'rejected', 'ارفض': 'rejected',
  cancel: 'cancelled', cancelled: 'cancelled', canceled: 'cancelled', 'إلغاء': 'cancelled', 'الغاء': 'cancelled',
  complete: 'completed', completed: 'completed', done: 'completed', 'إكمال': 'completed', 'اكمال': 'completed', 'تم': 'completed',
  contacted: 'contacted', 'تواصل': 'contacted',
  close: 'closed', closed: 'closed', 'إغلاق': 'closed', 'اغلاق': 'closed',
};

export interface OperatorCommand {
  status: CustomerRequestStatus;
  reference: string;
}

/** "CONFIRM APT-2026-3777" / "تأكيد APT-2026-3777" → command; anything else → null. Whole message must be the command. */
export function parseOperatorCommand(text: string | undefined): OperatorCommand | null {
  if (!text) return null;
  const m = text.trim().match(/^([A-Za-z\u0600-\u06FF]+)\s+((?:APT|INQ)-\d{4}-\d{4})\s*$/iu);
  if (!m) return null;
  const status = COMMANDS[m[1]!.toLowerCase()];
  if (!status) return null;
  return { status, reference: m[2]!.toUpperCase() };
}

/**
 * Applies an operator command. The caller MUST have verified the message came
 * from the business account itself (key.fromMe) — customers never reach this.
 * Returns the text to send back to the operator.
 */
export function handleOperatorCommand(command: OperatorCommand, actorDetail: string, db: Database.Database = getDb()): { text: string; result: StatusChangeResult | null } {
  const request = getCustomerRequestByReference(command.reference, db);
  if (!request) return { text: `⚠️ ${command.reference}: no such request. / لا يوجد طلب بهذا الرقم.`, result: null };
  const result = changeRequestStatus(request.id, command.status, { type: 'whatsapp', detail: actorDetail }, db)!;
  const customer = getCustomerById(result.request.customer_id, db);
  const vars = requestTemplateVars(result.request, customer, 'en', { actor: 'WhatsApp operator' });
  if (!result.changed) {
    return { text: `ℹ️ ${result.request.reference} is already ${statusLabel(result.request.status, 'en')} / الطلب بالفعل ${statusLabel(result.request.status, 'ar')}. Nothing re-sent.`, result };
  }
  return { text: resolveTemplate('staff_status_changed', 'en', vars, db), result };
}

/** Dashboard view: request + audit events + notification states. */
export function requestTimeline(requestId: number, db: Database.Database = getDb()): { events: RequestEvent[]; notifications: OutboxRow[] } {
  return { events: listRequestEvents(requestId, db), notifications: listOutbox({ requestId }, db) };
}
