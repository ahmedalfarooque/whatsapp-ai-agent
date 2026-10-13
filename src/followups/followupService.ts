import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { getDb } from '../memory/db';
import { logger } from '../logger';
import { currentAccountId } from '../accounts/accountContext';
import { getBusinessSettings, type BusinessSettings } from '../config/businessSettings';
import { describeMoment, isOpenAt, nextOpening, openIntervalAt } from '../setup/hours';
import { cancelJobsFor, registerJobHandler, scheduleJob, type ScheduledJob } from '../jobs/scheduler';
import { createStaffNotification, resolveStaffNotificationsFor } from '../notifications/staffNotifications';
import { enqueueNotification } from '../notifications/outbox';
import { businessNotificationJid, kickOutbox } from '../requests/requestService';
import { resolveTemplate } from '../templates/templateRepo';
import { getAppointmentType } from './appointmentTypes';
import {
  ACTIVE_FOLLOWUP_STATUSES,
  addFollowupEvent,
  getFollowup,
  getFollowupAnyAccount,
  insertFollowup,
  updateFollowup,
  type ContactMethod,
  type FollowupActor,
  type FollowupRequest,
  type FollowupStatus,
} from './followupRepo';

/**
 * Customer follow-up requests: the rules. A request is PERSISTED FIRST and confirmed only after the row exists; staff are told through a
 * persistent dashboard notification and the existing WhatsApp staff alert; reminders are durable jobs (scheduler.ts) that stop on
 * completion, cancellation or rescheduling; the "Call customer" window is enforced here (server) and only mirrored by the UI.
 *
 * Status model: pending (as soon as staff are available, business closed → waits for eligible_at) → eligible (actionable now) →
 * assigned (a staff member took it) → completed | cancelled; scheduled (agreed time) → [reminder] → overdue (window passed without an
 * outcome; needs reschedule or outcome). Rescheduling updates the same row (never a duplicate active task).
 */

export class FollowupError extends Error {
  constructor(message: string, public status = 400, public code = 'invalid') {
    super(message);
  }
}

export const MIN_LEAD_MINUTES = 5;
export const MAX_DAYS_AHEAD = 60;
export const JOB_REF = 'followup';
export const JOB_KINDS = { reminder: 'followup_reminder', eligible: 'followup_eligible', overdue: 'followup_overdue' } as const;

export interface CreateFollowupInput {
  customerId: number;
  conversationId?: number | null;
  contactMethod: ContactMethod;
  appointmentTypeKey?: string | null;
  /** The agreed moment; null with asap = "as soon as staff are available". */
  requestedAt?: Date | null;
  asap?: boolean;
  customerNote?: string | null;
  source?: 'customer' | 'staff' | 'ai';
  now?: Date;
}

const iso = (d: Date | DateTime): string => (d instanceof Date ? d : d.toJSDate()).toISOString();

/** Validates an agreed moment against the business schedule. Throws a FollowupError the caller turns into the right customer text. */
export function validateRequestedTime(settings: BusinessSettings, at: Date, now: Date = new Date()): void {
  if (Number.isNaN(at.getTime())) throw new FollowupError('invalid time', 400, 'invalid_time');
  if (at.getTime() < now.getTime() + MIN_LEAD_MINUTES * 60_000) throw new FollowupError('the time has already passed', 400, 'in_past');
  if (at.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86_400_000) throw new FollowupError(`the time is more than ${MAX_DAYS_AHEAD} days ahead`, 400, 'too_far');
  if (isOpenAt(settings, at) === false) throw new FollowupError('outside the opening hours', 400, 'outside_hours');
}

/** What the customer/staff see for "when": the agreed time in the business timezone, or the as-soon-as-possible wording. */
export function describeWhen(row: Pick<FollowupRequest, 'requested_at' | 'timezone' | 'eligible_at' | 'asap'>, language: 'ar' | 'en', now: Date = new Date()): string {
  if (row.requested_at) {
    const at = DateTime.fromISO(row.requested_at, { zone: row.timezone });
    return at.isValid ? describeMoment({ businessTimezone: row.timezone } as BusinessSettings, at, language, now) : row.requested_at;
  }
  if (row.eligible_at) {
    const at = DateTime.fromISO(row.eligible_at, { zone: row.timezone });
    return language === 'ar' ? `عند عودة الموظفين (${at.isValid ? describeMoment({ businessTimezone: row.timezone } as BusinessSettings, at, 'ar', now) : ''})` : `when staff are back (${at.isValid ? describeMoment({ businessTimezone: row.timezone } as BusinessSettings, at, 'en', now) : ''})`;
  }
  return language === 'ar' ? 'في أقرب وقت ممكن' : 'as soon as possible';
}

export function methodLabel(method: ContactMethod, language: 'ar' | 'en'): string {
  if (method === 'call') return language === 'ar' ? 'اتصال هاتفي' : 'Phone call';
  return language === 'ar' ? 'رسالة واتساب' : 'WhatsApp message';
}

function customerLine(row: FollowupRequest, db: Database.Database): string {
  const c = db.prepare('SELECT display_name, wa_id FROM customers WHERE id = ?').get(row.customer_id) as { display_name: string | null; wa_id: string } | undefined;
  if (!c) return `customer #${row.customer_id}`;
  const phone = /^\d{8,15}$/.test(c.wa_id) ? `+${c.wa_id}` : c.wa_id;
  return `${c.display_name ? `${c.display_name} · ` : ''}${phone}`;
}

function staffVars(row: FollowupRequest, db: Database.Database, language: 'ar' | 'en' = 'en') {
  return {
    customer: customerLine(row, db),
    type: row.appointment_type_label ?? (language === 'ar' ? 'غير محدد' : 'not specified'),
    method: methodLabel(row.contact_method, language),
    when: describeWhen(row, language),
    reference: row.reference,
    details: [row.customer_note ? `📝 ${row.customer_note}` : '', language === 'ar' ? 'لوحة التحكم → طابور الدعم البشري → طلبات المتابعة' : 'Dashboard → Human Support Queue → Follow-up requests'].filter(Boolean).join('\n'),
  };
}

/** Both staff channels for one event: the persistent dashboard notification (rings when asked) and the WhatsApp staff alert (existing outbox). */
function notifyStaff(row: FollowupRequest, kind: 'new' | 'reminder' | 'overdue' | 'eligible', opts: { ring: boolean; attempt?: number }, db: Database.Database = getDb()): void {
  const templateKey = kind === 'new' ? 'followup_staff_alert' : kind === 'reminder' ? 'followup_staff_reminder' : kind === 'overdue' ? 'followup_staff_overdue' : 'followup_staff_eligible';
  const dedupe = `followup:${kind}:${row.id}${opts.attempt ? `:${opts.attempt}` : ''}`;
  let body = '';
  try {
    body = resolveTemplate(templateKey, 'en', staffVars(row, db), db, row.whatsapp_account_id);
  } catch (error) {
    logger.warn({ id: row.id, error: String((error as Error).message) }, '[FOLLOWUP] staff alert template failed; a plain text is used');
    body = `${kind} follow-up ${row.reference}: ${customerLine(row, db)} · ${row.contact_method} · ${describeWhen(row, 'en')}`;
  }
  const title = kind === 'new' ? `New ${row.contact_method === 'call' ? 'callback' : 'WhatsApp'} request` : kind === 'reminder' ? `Time to ${row.contact_method === 'call' ? 'call' : 'message'} the customer` : kind === 'overdue' ? 'Follow-up overdue' : 'Follow-up ready';
  createStaffNotification({ accountId: row.whatsapp_account_id, adminUserId: row.assigned_admin_id, kind: `followup_${kind}`, title, body, followupId: row.id, customerId: row.customer_id, ring: opts.ring, dedupeKey: dedupe }, db);
  const jid = businessNotificationJid(db, row.whatsapp_account_id);
  if (jid) {
    enqueueNotification({ kind: 'staff_followup', targetJid: jid, body, dedupeKey: `outbox:${dedupe}`, accountId: row.whatsapp_account_id }, db);
    kickOutbox();
  }
  updateFollowup(row.id, { last_notified_at: new Date().toISOString() }, db);
}

function scheduleJobsFor(row: FollowupRequest, settings: BusinessSettings, db: Database.Database = getDb()): void {
  const base = { accountId: row.whatsapp_account_id, refKind: JOB_REF, refId: row.id, reopen: true } as const;
  if (row.status === 'scheduled' && row.requested_at) {
    const at = new Date(row.requested_at).getTime();
    scheduleJob({ ...base, kind: JOB_KINDS.reminder, runAt: at - settings.reminderLeadMinutes * 60_000, dedupeKey: `followup:reminder:${row.id}`, payload: { attempt: 1 } }, db);
    if (row.window_end_at) scheduleJob({ ...base, kind: JOB_KINDS.overdue, runAt: new Date(row.window_end_at), dedupeKey: `followup:overdue:${row.id}` }, db);
  } else if (row.status === 'pending' && row.eligible_at) {
    scheduleJob({ ...base, kind: JOB_KINDS.eligible, runAt: new Date(row.eligible_at), dedupeKey: `followup:eligible:${row.id}` }, db);
  }
}

/** Creates one request: validates, persists, notifies staff, schedules the jobs. Returns the stored row (status tells the caller what to say). */
export function createFollowup(input: CreateFollowupInput, db: Database.Database = getDb(), accountId: number = currentAccountId()): FollowupRequest {
  const now = input.now ?? new Date();
  const settings = getBusinessSettings(accountId);
  const type = input.appointmentTypeKey ? getAppointmentType(input.appointmentTypeKey, accountId, db) : undefined;
  if (input.appointmentTypeKey && (!type || !type.enabled)) throw new FollowupError('unknown appointment type', 400, 'unknown_type');
  const asap = !input.requestedAt;
  let status: FollowupStatus;
  let eligibleAt: string | null = null;
  let windowEndAt: string | null = null;
  if (input.requestedAt) {
    validateRequestedTime(settings, input.requestedAt, now);
    status = 'scheduled';
    windowEndAt = new Date(input.requestedAt.getTime() + settings.callbackWindowMinutes * 60_000).toISOString();
  } else {
    const open = isOpenAt(settings, now);
    if (open === false) {
      const next = nextOpening(settings, now);
      status = next ? 'pending' : 'eligible';
      eligibleAt = next ? iso(next) : null;
    } else {
      status = 'eligible';
    }
  }
  const row = db.transaction(() => {
    const created = insertFollowup({
      customerId: input.customerId, conversationId: input.conversationId ?? null, contactMethod: input.contactMethod, appointmentTypeKey: type?.key ?? null,
      appointmentTypeLabel: type ? type.labelEn : null, requestedAt: input.requestedAt ? iso(input.requestedAt) : null, timezone: settings.businessTimezone, asap,
      status, eligibleAt, windowEndAt, customerNote: input.customerNote ?? null, source: input.source ?? 'customer',
    }, db, accountId);
    addFollowupEvent({ followupId: created.id, accountId, event: 'created', toStatus: status, actor: input.source === 'staff' ? { type: 'system' } : { type: 'customer' }, detail: input.requestedAt ? `agreed ${created.requested_at}` : eligibleAt ? `waits for staff: eligible ${eligibleAt}` : 'as soon as possible' }, db);
    return created;
  })();
  scheduleJobsFor(row, settings, db);
  // Staff learn about every new request at once (the dashboard rings only when it becomes actionable: eligible/scheduled time).
  try { notifyStaff(row, 'new', { ring: row.status === 'eligible' }, db); } catch (error) { logger.warn({ id: row.id, error: String((error as Error).message) }, '[FOLLOWUP] staff notification failed'); }
  logger.info({ account: accountId, id: row.id, reference: row.reference, status: row.status, method: row.contact_method }, '[FOLLOWUP] request created');
  return row;
}

function transition(row: FollowupRequest, to: FollowupStatus, actor: FollowupActor, event: string, patch: Partial<Record<keyof FollowupRequest, string | number | null>>, detail: string | null, db: Database.Database): FollowupRequest {
  const updated = updateFollowup(row.id, { status: to, ...patch }, db);
  addFollowupEvent({ followupId: row.id, accountId: row.whatsapp_account_id, event, fromStatus: row.status, toStatus: to, actor, detail }, db);
  return updated;
}

function requireRow(id: number, db: Database.Database, accountId: number): FollowupRequest {
  const row = getFollowup(id, db, accountId);
  if (!row) throw new FollowupError('Follow-up request not found', 404, 'not_found');
  return row;
}

/** The customer, staff or the system cancels a request: jobs and open notifications stop; a finished request cannot be cancelled. */
export function cancelFollowup(id: number, actor: FollowupActor, reason: string | null = null, db: Database.Database = getDb(), accountId: number = currentAccountId()): FollowupRequest {
  const row = requireRow(id, db, accountId);
  if (!ACTIVE_FOLLOWUP_STATUSES.includes(row.status)) throw new FollowupError(`a ${row.status} request cannot be cancelled`, 409, 'not_active');
  const updated = transition(row, 'cancelled', actor, 'cancelled', { cancelled_at: new Date().toISOString(), cancelled_by: actor.type }, reason, db);
  cancelJobsFor(JOB_REF, row.id, undefined, db);
  resolveStaffNotificationsFor(row.id, db);
  return updated;
}

/** Staff record the outcome ("reached", "no answer", "voicemail", ...). Allowed from any active status; never from cancelled/completed. */
export function completeFollowup(id: number, adminId: number, outcome: string, note: string | null = null, db: Database.Database = getDb(), accountId: number = currentAccountId()): FollowupRequest {
  const row = requireRow(id, db, accountId);
  if (!ACTIVE_FOLLOWUP_STATUSES.includes(row.status)) throw new FollowupError(`a ${row.status} request cannot be completed`, 409, 'not_active');
  const clean = outcome.trim().slice(0, 60);
  if (!clean) throw new FollowupError('an outcome is required', 400, 'invalid');
  const updated = transition(row, 'completed', { type: 'staff', adminId }, 'completed', { completed_at: new Date().toISOString(), outcome: clean, outcome_note: note?.trim().slice(0, 1000) || null, assigned_admin_id: row.assigned_admin_id ?? adminId }, clean, db);
  cancelJobsFor(JOB_REF, row.id, undefined, db);
  resolveStaffNotificationsFor(row.id, db);
  return updated;
}

/** A new agreed time for the SAME request (no duplicate task): the old reminders are cancelled and new ones scheduled. */
export function rescheduleFollowup(id: number, actor: FollowupActor, at: Date, db: Database.Database = getDb(), accountId: number = currentAccountId(), now: Date = new Date()): FollowupRequest {
  const row = requireRow(id, db, accountId);
  if (!ACTIVE_FOLLOWUP_STATUSES.includes(row.status)) throw new FollowupError(`a ${row.status} request cannot be rescheduled`, 409, 'not_active');
  const settings = getBusinessSettings(accountId);
  validateRequestedTime(settings, at, now);
  const updated = transition(row, 'scheduled', actor, 'rescheduled', {
    requested_at: at.toISOString(), asap: 0, eligible_at: null, window_end_at: new Date(at.getTime() + settings.callbackWindowMinutes * 60_000).toISOString(), reminder_attempts: 0,
  }, `from ${row.requested_at ?? 'asap'} to ${at.toISOString()}`, db);
  cancelJobsFor(JOB_REF, row.id, undefined, db);
  resolveStaffNotificationsFor(row.id, db);
  scheduleJobsFor(updated, settings, db);
  try { notifyStaff(updated, 'new', { ring: false }, db); } catch { /* reported in the log by notifyStaff's callers */ }
  return updated;
}

export function assignFollowup(id: number, adminId: number, actor: FollowupActor, db: Database.Database = getDb(), accountId: number = currentAccountId()): FollowupRequest {
  const row = requireRow(id, db, accountId);
  if (!ACTIVE_FOLLOWUP_STATUSES.includes(row.status)) throw new FollowupError(`a ${row.status} request cannot be assigned`, 409, 'not_active');
  const to: FollowupStatus = row.status === 'eligible' || row.status === 'pending' ? 'assigned' : row.status;
  return transition(row, to, actor, 'assigned', { assigned_admin_id: adminId }, `admin ${adminId}`, db);
}

/** Validated dial target for the device's ordinary phone dialler. Never a WhatsApp call. null when the customer has no real number (privacy id). */
export function telUrlFor(waId: string): string | null {
  const digits = waId.replace(/[^\d]/g, '');
  if (!/^\d{8,15}$/.test(digits) || digits !== waId.replace(/^\+/, '')) return null;
  return `tel:${encodeURIComponent(`+${digits}`)}`;
}

export interface CallWindow {
  /** before: the agreed time has not come; open: the action is allowed now; after: the window passed (reschedule or record the outcome); closed: finished. */
  state: 'before' | 'open' | 'after' | 'closed';
  opensAt: string | null;
  closesAt: string | null;
  allowed: boolean;
  reason: string;
}

/** The server-side rule behind the "Call customer" / "Reply on WhatsApp" actions. */
export function callWindow(row: FollowupRequest, now: Date = new Date()): CallWindow {
  const t = now.getTime();
  if (row.status === 'cancelled' || row.status === 'completed') return { state: 'closed', opensAt: null, closesAt: null, allowed: false, reason: `request is ${row.status}` };
  if (row.requested_at) {
    const start = new Date(row.requested_at).getTime();
    const end = row.window_end_at ? new Date(row.window_end_at).getTime() : start + 30 * 60_000;
    if (t < start) return { state: 'before', opensAt: row.requested_at, closesAt: row.window_end_at, allowed: false, reason: 'the agreed time has not come yet' };
    if (t >= end || row.status === 'overdue') return { state: 'after', opensAt: row.requested_at, closesAt: row.window_end_at, allowed: false, reason: 'the callback window has passed: reschedule or record the outcome' };
    return { state: 'open', opensAt: row.requested_at, closesAt: row.window_end_at, allowed: true, reason: 'inside the agreed window' };
  }
  if (row.status === 'pending' && row.eligible_at && t < new Date(row.eligible_at).getTime()) return { state: 'before', opensAt: row.eligible_at, closesAt: null, allowed: false, reason: 'waiting for the business to open' };
  return { state: 'open', opensAt: row.eligible_at, closesAt: null, allowed: true, reason: 'as soon as possible' };
}

/** Opening the dialler is an action, not an outcome: it is recorded, and the request stays active until staff record what happened. */
export function recordCallOpened(id: number, adminId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): { row: FollowupRequest; tel: string | null; window: CallWindow } {
  const row = requireRow(id, db, accountId);
  const window = callWindow(row);
  if (!window.allowed) throw new FollowupError(window.reason, 409, window.state === 'before' ? 'too_early' : window.state === 'after' ? 'window_passed' : 'not_active');
  const customer = db.prepare('SELECT wa_id FROM customers WHERE id = ? AND whatsapp_account_id = ?').get(row.customer_id, accountId) as { wa_id: string } | undefined;
  const tel = customer ? telUrlFor(customer.wa_id) : null;
  if (!tel) throw new FollowupError('this customer has no dialable phone number (privacy id only)', 409, 'no_number');
  addFollowupEvent({ followupId: row.id, accountId, event: 'call_opened', actor: { type: 'staff', adminId }, detail: 'device dialler opened (not a completed call)' }, db);
  // Whoever calls takes the request (unless it already has an owner); an overdue one stays overdue until an outcome or a new time is recorded.
  const updated = row.status !== 'assigned' && row.status !== 'overdue' ? transition(row, 'assigned', { type: 'staff', adminId }, 'assigned', { assigned_admin_id: row.assigned_admin_id ?? adminId }, 'took the request by calling', db) : row;
  return { row: updated, tel, window };
}

// ---------------------------------------------------------------- durable job handlers

async function onReminder(job: ScheduledJob, payload: Record<string, unknown>): Promise<void> {
  const db = getDb();
  const row = getFollowupAnyAccount(job.ref_id, db);
  if (!row || !['scheduled', 'assigned'].includes(row.status)) return; // cancelled/completed meanwhile: nothing to remind
  const settings = getBusinessSettings(row.whatsapp_account_id);
  const attempt = Number(payload.attempt ?? 1);
  notifyStaff(row, 'reminder', { ring: true, attempt }, db);
  updateFollowup(row.id, { reminder_attempts: attempt }, db);
  addFollowupEvent({ followupId: row.id, accountId: row.whatsapp_account_id, event: 'reminder_sent', actor: { type: 'system' }, detail: `attempt ${attempt}` }, db);
  if (attempt < settings.reminderMaxAttempts) {
    scheduleJob({ accountId: row.whatsapp_account_id, kind: JOB_KINDS.reminder, refKind: JOB_REF, refId: row.id, runAt: Date.now() + settings.reminderRepeatMinutes * 60_000, dedupeKey: `followup:reminder:${row.id}:${attempt + 1}`, payload: { attempt: attempt + 1 } }, db);
  }
}

async function onEligible(job: ScheduledJob): Promise<void> {
  const db = getDb();
  const row = getFollowupAnyAccount(job.ref_id, db);
  if (!row || row.status !== 'pending') return;
  const updated = transition(row, 'eligible', { type: 'system' }, 'eligible', {}, 'the business opened', db);
  notifyStaff(updated, 'eligible', { ring: true }, db);
}

async function onOverdue(job: ScheduledJob): Promise<void> {
  const db = getDb();
  const row = getFollowupAnyAccount(job.ref_id, db);
  if (!row || !['scheduled', 'assigned'].includes(row.status)) return;
  const updated = transition(row, 'overdue', { type: 'system' }, 'overdue', {}, 'the callback window passed without an outcome', db);
  cancelJobsFor(JOB_REF, row.id, JOB_KINDS.reminder, db);
  notifyStaff(updated, 'overdue', { ring: false }, db);
}

/** Registers the three handlers with the scheduler (idempotent; called at boot and by tests). */
export function registerFollowupJobs(): void {
  registerJobHandler(JOB_KINDS.reminder, onReminder);
  registerJobHandler(JOB_KINDS.eligible, onEligible);
  registerJobHandler(JOB_KINDS.overdue, onOverdue);
}

/** True when the business is open now AND a direct call can be offered (number configured, feature on). */
export function directCallAvailable(settings: BusinessSettings, now: Date = new Date()): { available: boolean; phone: string | null; until: DateTime | null } {
  if (!settings.directCallEnabled || !settings.contactPhone) return { available: false, phone: settings.contactPhone, until: null };
  const interval = openIntervalAt(settings, now);
  return { available: interval !== null, phone: settings.contactPhone, until: interval?.end ?? null };
}
