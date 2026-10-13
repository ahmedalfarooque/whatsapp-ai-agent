import type { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { currentAccountId } from '../accounts/accountContext';
import { getDb } from '../memory/db';
import { getBusinessSettings } from '../config/businessSettings';
import { isOpenAt, nextOpening } from '../setup/hours';
import { featureLevel, levelAtLeast, accessibleAccountIds, type AuthUser } from './permissions';
import { listAppointmentTypes } from '../followups/appointmentTypes';
import { followupCounts, getFollowup, listFollowupEvents, listFollowups, type FollowupListItem, type FollowupRequest, type FollowupStatus } from '../followups/followupRepo';
import { assignFollowup, callWindow, cancelFollowup, completeFollowup, createFollowup, describeWhen, FollowupError, recordCallOpened, rescheduleFollowup, telUrlFor } from '../followups/followupService';
import { listJobsFor } from '../jobs/scheduler';
import { listStaffNotifications, markStaffNotificationRead, unreadStaffNotificationCount } from '../notifications/staffNotifications';

/**
 * Follow-up requests (callbacks / staff WhatsApp messages) and staff notifications, for the SELECTED account only (the account middleware
 * checked the user may open it; authorize.ts that they hold the "support" feature: view to read, edit to act). Every id in a URL is looked
 * up inside the selected account, so another business's request is "not found". The call window is enforced here, not only in the UI.
 */

function fail(res: Response, error: unknown): void {
  if (error instanceof FollowupError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  logger.error({ errorName: (error as Error)?.name, errorMessage: String((error as Error)?.message ?? error).slice(0, 200) }, 'follow-up request failed');
  res.status(500).json({ error: 'internal_server_error' });
}

/** The businesses whose notifications this user may see ('all' = every account). */
function accountIdsFor(user: AuthUser): number[] {
  const ids = accessibleAccountIds(user);
  if (ids !== 'all') return ids;
  return (getDb().prepare('SELECT id FROM whatsapp_accounts').all() as { id: number }[]).map((r) => r.id);
}

function idParam(req: Request): number {
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) throw new FollowupError('Invalid id', 400, 'invalid');
  return id;
}

const FILTERS: Record<string, readonly FollowupStatus[]> = {
  open: ['pending', 'scheduled', 'eligible', 'assigned', 'overdue'],
  due: ['eligible', 'assigned', 'overdue'],
  scheduled: ['scheduled', 'pending'],
  overdue: ['overdue'],
  completed: ['completed'],
  cancelled: ['cancelled'],
};

function view(row: FollowupListItem | FollowupRequest, user: AuthUser, now: Date) {
  const window = callWindow(row, now);
  const customerWaId = 'customer_wa_id' in row ? row.customer_wa_id : (getDb().prepare('SELECT wa_id FROM customers WHERE id = ?').get(row.customer_id) as { wa_id: string } | undefined)?.wa_id ?? '';
  const canAct = levelAtLeast(featureLevel(user, currentAccountId(), 'support'), 'edit');
  return {
    id: row.id, reference: row.reference, status: row.status, contactMethod: row.contact_method, appointmentTypeKey: row.appointment_type_key, appointmentType: row.appointment_type_label,
    requestedAt: row.requested_at, timezone: row.timezone, asap: row.asap === 1, eligibleAt: row.eligible_at, windowEndAt: row.window_end_at, when: describeWhen(row, 'en', now),
    assignedAdminId: row.assigned_admin_id, assignedToName: 'assigned_to_name' in row ? row.assigned_to_name : null, customerNote: row.customer_note, outcome: row.outcome, outcomeNote: row.outcome_note,
    reminderAttempts: row.reminder_attempts, lastNotifiedAt: row.last_notified_at, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at, cancelledAt: row.cancelled_at,
    customerId: row.customer_id, customerName: 'customer_name' in row ? row.customer_name : null, customerWaId, customerLanguage: 'customer_language' in row ? row.customer_language : null,
    conversationLink: `#/conversations/customer/${row.customer_id}`,
    call: { ...window, tel: window.allowed && row.contact_method === 'call' ? telUrlFor(customerWaId) : null, dialable: telUrlFor(customerWaId) !== null },
    actions: {
      canAct, complete: canAct && FILTERS.open!.includes(row.status), cancel: canAct && FILTERS.open!.includes(row.status), reschedule: canAct && FILTERS.open!.includes(row.status),
      assign: canAct && FILTERS.open!.includes(row.status), call: canAct && row.contact_method === 'call' && window.allowed, reply: canAct && window.allowed,
    },
  };
}

export function registerFollowupRoutes(router: Router): void {
  router.get('/api/dashboard/followups', (req, res) => {
    try {
      const user = req.authUser as AuthUser;
      const filter = typeof req.query.state === 'string' && FILTERS[req.query.state] ? FILTERS[req.query.state]! : FILTERS.open!;
      const customerId = typeof req.query.customerId === 'string' ? Number.parseInt(req.query.customerId, 10) : undefined;
      const now = new Date();
      const settings = getBusinessSettings();
      const open = isOpenAt(settings, now);
      const next = nextOpening(settings, now);
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        followups: listFollowups({ statuses: filter, customerId: Number.isInteger(customerId) ? customerId : undefined, limit: 200 }).map((r) => view(r, user, now)),
        counts: followupCounts(),
        business: { open, nextOpening: next ? next.toISO() : null, timezone: settings.businessTimezone, hoursConfigured: settings.hoursConfigured, callbackWindowMinutes: settings.callbackWindowMinutes },
        appointmentTypes: listAppointmentTypes(undefined, {}),
        generatedAt: now.toISOString(),
      });
    } catch (error) { fail(res, error); }
  });

  router.get('/api/dashboard/followups/:id', (req, res) => {
    try {
      const row = getFollowup(idParam(req));
      if (!row) throw new FollowupError('Follow-up request not found', 404, 'not_found');
      res.json({ followup: view(row, req.authUser as AuthUser, new Date()), events: listFollowupEvents(row.id), jobs: listJobsFor('followup', row.id).map((j) => ({ id: j.id, kind: j.kind, runAt: j.run_at, status: j.status, attempts: j.attempts, lastError: j.last_error })) });
    } catch (error) { fail(res, error); }
  });

  /** Staff create a request on a customer's behalf (from the conversation). */
  router.post('/api/dashboard/followups', (req, res) => {
    try {
      const user = req.authUser as AuthUser;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const customerId = Number.parseInt(String(body.customerId), 10);
      if (!Number.isInteger(customerId)) throw new FollowupError('customerId is required', 400, 'invalid');
      const exists = getDb().prepare('SELECT id FROM customers WHERE id = ? AND whatsapp_account_id = ?').get(customerId, currentAccountId());
      if (!exists) throw new FollowupError('Customer not found', 404, 'not_found');
      const method = body.contactMethod === 'whatsapp' ? 'whatsapp' : body.contactMethod === 'call' ? 'call' : null;
      if (!method) throw new FollowupError('contactMethod must be call or whatsapp', 400, 'invalid');
      const requestedAt = typeof body.requestedAt === 'string' && body.requestedAt ? new Date(body.requestedAt) : null;
      const row = createFollowup({ customerId, contactMethod: method, appointmentTypeKey: typeof body.appointmentTypeKey === 'string' ? body.appointmentTypeKey : null, requestedAt, asap: !requestedAt, customerNote: typeof body.note === 'string' ? body.note.slice(0, 1000) : null, source: 'staff' });
      if (!row.assigned_admin_id) assignFollowup(row.id, user.id, { type: 'staff', adminId: user.id });
      res.status(201).json({ followup: view(getFollowup(row.id)!, user, new Date()) });
    } catch (error) { fail(res, error); }
  });

  router.post('/api/dashboard/followups/:id/assign', (req, res) => {
    try {
      const user = req.authUser as AuthUser;
      const adminId = Number.parseInt(String((req.body ?? {}).adminId ?? user.id), 10);
      const row = assignFollowup(idParam(req), Number.isInteger(adminId) ? adminId : user.id, { type: 'staff', adminId: user.id });
      res.json({ ok: true, followup: view(row, user, new Date()) });
    } catch (error) { fail(res, error); }
  });

  router.post('/api/dashboard/followups/:id/complete', (req, res) => {
    try {
      const user = req.authUser as AuthUser;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const row = completeFollowup(idParam(req), user.id, String(body.outcome ?? ''), typeof body.note === 'string' ? body.note : null);
      res.json({ ok: true, followup: view(row, user, new Date()) });
    } catch (error) { fail(res, error); }
  });

  router.post('/api/dashboard/followups/:id/cancel', (req, res) => {
    try {
      const user = req.authUser as AuthUser;
      const row = cancelFollowup(idParam(req), { type: 'staff', adminId: user.id }, typeof (req.body ?? {}).reason === 'string' ? String(req.body.reason).slice(0, 300) : 'cancelled by staff');
      res.json({ ok: true, followup: view(row, user, new Date()) });
    } catch (error) { fail(res, error); }
  });

  router.post('/api/dashboard/followups/:id/reschedule', (req, res) => {
    try {
      const user = req.authUser as AuthUser;
      const at = new Date(String((req.body ?? {}).requestedAt ?? ''));
      if (Number.isNaN(at.getTime())) throw new FollowupError('requestedAt must be an ISO date-time', 400, 'invalid_time');
      const row = rescheduleFollowup(idParam(req), { type: 'staff', adminId: user.id }, at);
      res.json({ ok: true, followup: view(row, user, new Date()) });
    } catch (error) { fail(res, error); }
  });

  /** "Call customer": the server decides whether the window is open and returns the validated tel: URL; the browser only opens it. */
  router.post('/api/dashboard/followups/:id/call', (req, res) => {
    try {
      const user = req.authUser as AuthUser;
      const { row, tel, window } = recordCallOpened(idParam(req), user.id);
      res.json({ ok: true, tel, window, followup: view(row, user, new Date()) });
    } catch (error) { fail(res, error); }
  });

  // ---- staff notifications (bell): the user's own and the unassigned ones, in the businesses they may open
  router.get('/api/dashboard/staff-notifications', (req, res) => {
    try {
      const user = req.authUser as AuthUser;
      const accountIds = accountIdsFor(user);
      const afterId = typeof req.query.after === 'string' ? Number.parseInt(req.query.after, 10) : undefined;
      const status = req.query.status === 'all' ? undefined : 'open';
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        notifications: listStaffNotifications({ accountIds, adminUserId: user.id, status, afterId: Number.isInteger(afterId) ? afterId : undefined, limit: 50 }).map((n) => ({
          id: n.id, accountId: n.whatsapp_account_id, kind: n.kind, title: n.title, body: n.body, followupId: n.followup_id, customerId: n.customer_id, ring: n.ring === 1, status: n.status, createdAt: n.created_at,
          conversationLink: n.customer_id ? `#/conversations/customer/${n.customer_id}` : null,
        })),
        unread: unreadStaffNotificationCount(accountIds, user.id),
        generatedAt: new Date().toISOString(),
      });
    } catch (error) { fail(res, error); }
  });

  router.post('/api/dashboard/staff-notifications/:id/read', (req, res) => {
    try {
      const user = req.authUser as AuthUser;
      res.json({ ok: markStaffNotificationRead(idParam(req), accountIdsFor(user)) });
    } catch (error) { fail(res, error); }
  });
}
