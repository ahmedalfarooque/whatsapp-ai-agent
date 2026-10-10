import type { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { currentAccountId } from '../accounts/accountContext';
import { getDb } from '../memory/db';
import { getConversationMessages } from '../memory/conversationRepo';
import { getCustomerById } from '../memory/customerRepo';
import {
  HOLDING_STATES,
  HandoffError,
  acceptHandoff,
  getHandoff,
  getHandoffEvents,
  handoffCounts,
  listHandoffs,
  resolveHandoff,
  returnToAi,
  takeOverCustomer,
  type HandoffActor,
  type HandoffState,
} from '../handoff/handoffRepo';
import { StaffReplyError, sendStaffReply } from '../handoff/staffReply';
import { sendStaffText, type StaffSender } from '../whatsapp/staffSend';
import { featureLevel, levelAtLeast, type AuthUser } from './permissions';

/**
 * Human handoff: the queue, the staff takeover and the staff reply, for the SELECTED account only (the account middleware has already
 * checked that the user may open it, and authorize.ts that they hold the "support" feature: view for reading, edit for acting).
 * Whatever id comes in the URL is looked up inside the selected account, so another business's handoff is simply "not found".
 */

let staffSender: StaffSender = sendStaffText;
/** Test hook: replaces the WhatsApp sender (the real one needs a live connection). */
export function setStaffSender(sender: StaffSender | null): void {
  staffSender = sender ?? sendStaffText;
}

function fail(res: Response, error: unknown): void {
  if (error instanceof HandoffError || error instanceof StaffReplyError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  logger.error({ errorName: (error as Error)?.name, errorMessage: String((error as Error)?.message ?? error).slice(0, 200) }, 'handoff request failed');
  res.status(500).json({ error: 'internal_server_error' });
}

/** The acting staff member. "canManage" (the manage level of the support feature) lets someone act on a conversation another person owns. */
function staffActor(req: Request): Extract<HandoffActor, { type: 'staff' }> {
  const user = req.authUser as AuthUser;
  return { type: 'staff', adminId: user.id, canManage: levelAtLeast(featureLevel(user, currentAccountId(), 'support'), 'manage') };
}

function idParam(req: Request): number {
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) throw new HandoffError('Invalid id', 400, 'invalid');
  return id;
}

const STATE_FILTERS: Record<string, readonly HandoffState[]> = {
  waiting: ['HUMAN_REQUESTED'],
  active: ['HUMAN_ACTIVE'],
  resolved: ['RESOLVED'],
  open: HOLDING_STATES,
};

/** The customer's newest conversation (read-only: opening a handoff never creates one). */
function messagesOfLatestConversation(customerId: number) {
  const row = getDb().prepare('SELECT id FROM conversations WHERE customer_id = ? ORDER BY id DESC LIMIT 1').get(customerId) as { id: number } | undefined;
  return row ? getConversationMessages(row.id) : [];
}

function view(handoffId: number, req: Request) {
  const accountId = currentAccountId();
  const handoff = getHandoff(handoffId, accountId);
  const user = req.authUser as AuthUser;
  const customer = getCustomerById(handoff.customerId);
  const owner = handoff.assignedAdminId
    ? (getDb().prepare(`SELECT id, COALESCE(NULLIF(display_name, ''), email, username) AS name FROM admin_users WHERE id = ?`).get(handoff.assignedAdminId) as { id: number; name: string } | undefined) ?? null
    : null;
  const actor = staffActor(req);
  return {
    handoff,
    customer: customer ? { id: customer.id, name: customer.display_name, waId: customer.wa_id, language: customer.language } : null,
    assignedTo: owner,
    // What THIS user may do right now — for the buttons; the server checks again on every action.
    you: {
      id: user.id,
      owns: handoff.assignedAdminId === user.id,
      canAct: levelAtLeast(featureLevel(user, accountId, 'support'), 'edit'),
      canOverride: actor.canManage,
      canSeeConversation: levelAtLeast(featureLevel(user, accountId, 'conversations'), 'view'),
    },
  };
}

export function registerHandoffRoutes(router: Router): void {
  router.get('/api/dashboard/handoffs', (req, res) => {
    const filter = typeof req.query.state === 'string' && STATE_FILTERS[req.query.state] ? STATE_FILTERS[req.query.state]! : STATE_FILTERS.open!;
    const items = listHandoffs({ states: filter, limit: 100 }).map((h) => ({
      id: h.id, state: h.state, source: h.source, reason: h.reason, requestCount: h.requestCount, requestedAt: h.requestedAt, lastRequestedAt: h.lastRequestedAt,
      acceptedAt: h.acceptedAt, resolvedAt: h.resolvedAt, customerId: h.customerId, customerName: h.customerName, customerWaId: h.customerWaId, customerLanguage: h.customerLanguage,
      assignedAdminId: h.assignedAdminId, assignedToName: h.assignedToName, lastMessage: h.lastMessage, lastMessageAt: h.lastMessageAt,
    }));
    res.json({ handoffs: items, counts: handoffCounts() });
  });

  router.get('/api/dashboard/handoffs/:id', (req, res) => {
    try {
      const id = idParam(req);
      const body = view(id, req);
      // The message history needs the "conversations" permission as well: support access alone does not open a customer's chat.
      const messages = body.you.canSeeConversation
        ? messagesOfLatestConversation(body.handoff.customerId)
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .slice(-200)
            .map((m) => {
              let meta: { staff?: boolean } = {};
              try { meta = m.metadata ? (JSON.parse(m.metadata) as { staff?: boolean }) : {}; } catch { meta = {}; }
              return { id: m.id, role: m.role, staff: Boolean(meta.staff), content: m.content, createdAt: m.created_at };
            })
        : null;
      res.json({ ...body, messages, events: getHandoffEvents(id) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/api/dashboard/handoffs/:id/accept', (req, res) => {
    try {
      const { changed } = acceptHandoff(idParam(req), staffActor(req));
      res.json({ ok: true, changed, ...view(idParam(req), req) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/api/dashboard/handoffs/:id/resolve', (req, res) => {
    try {
      const { changed } = resolveHandoff(idParam(req), staffActor(req));
      res.json({ ok: true, changed, ...view(idParam(req), req) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/api/dashboard/handoffs/:id/return-to-ai', (req, res) => {
    try {
      const { changed } = returnToAi(idParam(req), staffActor(req));
      res.json({ ok: true, changed, ...view(idParam(req), req) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/api/dashboard/handoffs/:id/reply', async (req, res) => {
    try {
      const user = req.authUser as AuthUser;
      // Replying needs to see the conversation it answers.
      if (!levelAtLeast(featureLevel(user, currentAccountId(), 'conversations'), 'view')) {
        res.status(403).json({ error: 'forbidden', message: 'You need access to conversations to reply to a customer' });
        return;
      }
      const body = (req.body ?? {}) as { text?: unknown; clientMessageId?: unknown };
      const result = await sendStaffReply({ handoffId: idParam(req), text: body.text, clientMessageId: body.clientMessageId }, staffActor(req), staffSender);
      res.json({ ok: true, ...result });
    } catch (error) {
      fail(res, error);
    }
  });

  // Staff take over a customer's conversation without the customer having asked (the assistant stops answering them at once).
  router.post('/api/dashboard/customers/:id/take-over', (req, res) => {
    try {
      const customerId = idParam(req);
      if (!getCustomerById(customerId)) throw new HandoffError('Customer not found', 404, 'not_found');
      const { handoff, changed } = takeOverCustomer(customerId, staffActor(req));
      res.json({ ok: true, changed, handoffId: handoff.id, state: handoff.state });
    } catch (error) {
      fail(res, error);
    }
  });
}
