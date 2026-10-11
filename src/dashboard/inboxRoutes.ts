import type { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { currentAccountId } from '../accounts/accountContext';
import { getAccount } from '../accounts/accountRepo';
import { getQrStatus } from '../whatsapp/qrConnection';
import { getOpenHandoff } from '../handoff/handoffRepo';
import {
  HANDLING_FILTERS,
  clampPage,
  customerInAccount,
  inboxCounts,
  inboxRevision,
  listInbox,
  threadMessages,
  type AssigneeFilter,
  type HandlingFilter,
  type InboxSort,
} from '../inbox/inboxRepo';
import { handoffView } from './handoffRoutes';
import { featureLevel, levelAtLeast, type AuthUser } from './permissions';

/**
 * The unified inbox API. Read-only: every action (accept, reply, resolve, return to AI, take over) stays on the handoff routes with their
 * own permission and ownership checks, so the inbox can never do anything the handoff API does not allow.
 * Needs the `conversations` feature (view). Extra details are shown only to users who hold the feature that already exposes them:
 *   full customer number  -> `customers` (view)        staff names and assignee filter -> `support` (view)
 */

function capabilities(req: Request) {
  const user = req.authUser as AuthUser;
  const accountId = currentAccountId();
  const level = (feature: Parameters<typeof featureLevel>[2]) => featureLevel(user, accountId, feature);
  return {
    id: user.id,
    canSeeNumber: levelAtLeast(level('customers'), 'view'),
    canSeeStaff: levelAtLeast(level('support'), 'view'),
    canAct: levelAtLeast(level('support'), 'edit'),
  };
}

/** Whether the account's WhatsApp number is connected right now (so the browser can say so instead of looking idle). */
function connectionOf(accountId: number): { method: string; phase: string; connected: boolean } {
  const account = getAccount(accountId);
  if (!account || account.connectionMethod !== 'qr') return { method: account?.connectionMethod ?? 'qr', phase: 'cloud', connected: true };
  const phase = getQrStatus(accountId).phase;
  return { method: 'qr', phase, connected: phase === 'connected' };
}

function fail(res: Response, error: unknown): void {
  logger.error({ errorName: (error as Error)?.name, errorMessage: String((error as Error)?.message ?? error).slice(0, 200) }, 'inbox request failed');
  res.status(500).json({ error: 'internal_server_error' });
}

function parseAssignee(value: unknown): AssigneeFilter | undefined {
  if (value === 'me' || value === 'unassigned') return value;
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n > 0 && String(n) === String(value) ? n : undefined;
}

function optionalId(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number.parseInt(String(value), 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function registerInboxRoutes(router: Router): void {
  router.get('/api/dashboard/inbox', (req, res) => {
    try {
      const accountId = currentAccountId();
      const caps = capabilities(req);
      const handling = HANDLING_FILTERS.includes(req.query.handling as HandlingFilter) ? (req.query.handling as HandlingFilter) : 'all';
      const sort: InboxSort = req.query.sort === 'waiting_first' ? 'waiting_first' : 'recent';
      const page = clampPage(req.query.limit, req.query.offset);
      const result = listInbox({
        q: typeof req.query.q === 'string' ? req.query.q : undefined,
        handling,
        // Filtering by who handles a conversation reveals who handles it: only for users who may see staff.
        assignee: caps.canSeeStaff ? parseAssignee(req.query.assignee) : undefined,
        sort,
        ...page,
        viewerAdminId: caps.id,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        items: result.items.map(({ waId, ...item }) => ({
          ...item,
          ...(caps.canSeeNumber ? { waId } : {}),
          handling: { ...item.handling, assignedToName: caps.canSeeStaff ? item.handling.assignedToName : null, assignedAdminId: caps.canSeeStaff ? item.handling.assignedAdminId : null },
        })),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        counts: inboxCounts(),
        revision: inboxRevision(),
        connection: connectionOf(accountId),
        account: { id: accountId, name: getAccount(accountId)?.name ?? '' },
        you: caps,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  // Polled every few seconds by an open inbox: one tiny query, so the list is only reloaded when something actually changed.
  router.get('/api/dashboard/inbox/pulse', (_req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ revision: inboxRevision(), connection: connectionOf(currentAccountId()) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/api/dashboard/inbox/customers/:id', (req, res) => {
    try {
      const accountId = currentAccountId();
      const customerId = optionalId(req.params.id);
      const customer = customerId ? customerInAccount(customerId, accountId) : undefined;
      if (!customerId || !customer) {
        res.status(404).json({ error: 'Conversation not found', code: 'not_found' }); // another account's customer looks exactly like a missing one
        return;
      }
      const caps = capabilities(req);
      const thread = threadMessages(customerId, { before: optionalId(req.query.before), after: req.query.after === undefined ? undefined : Number.parseInt(String(req.query.after), 10) || 0, limit: req.query.limit === undefined ? undefined : Number.parseInt(String(req.query.limit), 10) }, accountId);
      const open = getOpenHandoff(customerId);
      let handoff: ReturnType<typeof handoffView> | null = null;
      if (open) {
        handoff = handoffView(open.id, req);
        if (!caps.canSeeStaff) handoff = { ...handoff, assignedTo: null, handoff: { ...handoff.handoff, assignedAdminId: null } };
        if (!caps.canSeeNumber && handoff.customer) handoff = { ...handoff, customer: { ...handoff.customer, waId: '' } };
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json({
        customer: { id: customer.id, name: customer.display_name, waIdMasked: customer.wa_id.replace(/\d(?=\d{4})/g, '•'), ...(caps.canSeeNumber ? { waId: customer.wa_id } : {}), language: customer.language },
        account: { id: accountId, name: getAccount(accountId)?.name ?? '' },
        ...thread,
        handoff,
        connection: connectionOf(accountId),
        you: caps,
      });
    } catch (error) {
      fail(res, error);
    }
  });
}
