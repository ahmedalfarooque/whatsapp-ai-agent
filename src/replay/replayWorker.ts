import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { logger, maskWaId } from '../logger';
import { runWithAccount } from '../accounts/accountContext';
import { getAutomationSettings } from '../automation/settingsRepo';
import { getCustomerById } from '../memory/customerRepo';
import { getHold } from '../handoff/handoffRepo';
import { buildCandidates } from '../llm/aiRouter';
import { processInboundMessage } from '../pipeline/processInboundMessage';
import type { KnowledgeBase } from '../knowledge/loader';
import { MAX_REPLAY_ATTEMPTS, REPLAY_MAX_AGE_MS, claimForReplay, listReplayCandidates, releaseAfterFailedReplay, setPendingStatus, getPendingReply, type PendingReply } from './pendingReplyRepo';

/**
 * Safe replay of customer messages that were never answered: the assistant was unreachable (every route failed) or the process was
 * interrupted mid-way. It is deliberately conservative — a late answer must never be a duplicate, a wrong-context answer or a repeated side
 * effect:
 *   - only the newest waiting message of a customer is replayed (the model reads the whole conversation, so one answer covers the older ones);
 *   - never older than REPLAY_MAX_AGE_MS, never more than MAX_REPLAY_ATTEMPTS times, never while a person owns the customer, never when
 *     automatic replies / the assistant are off, never when the customer is inside a guided flow;
 *   - never when anything other than the automated notice was sent after the message (the customer already got an answer — from the
 *     assistant or from staff), and never when a tool ran after it (a booking or hand-off may already have happened): those go to staff;
 *   - one replay at a time per message (an atomic claim), and a replay that fails again sends nothing;
 *   - a replay is only tried when a usable AI route exists, so a provider outage does not burn the attempts.
 * It never touches history, memory, reply mode, templates or any other account's data.
 */
const REPLAY_BATCH = 20;

/** How a replay is delivered: the connection layer runs `fn` inside the account's live reply transport (or throws when not connected). */
export interface ReplayRunner {
  run(row: PendingReply, replyJid: string | null, fn: (knowledge: KnowledgeBase | undefined) => Promise<void>): Promise<void>;
}

export interface ReplaySweepResult { replayed: number; answered: number; abandoned: number; needsStaff: number; waiting: number }

type Verdict = { ok: true; text: string } | { ok: false; action: 'abandon' | 'staff' | 'wait'; reason: string };

function assess(row: PendingReply, now: Date, db: Database.Database): Verdict {
  const age = now.getTime() - Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
  if (age > REPLAY_MAX_AGE_MS) return { ok: false, action: 'abandon', reason: 'too old to answer now (a late reply would confuse the customer)' };
  if (row.attempts >= MAX_REPLAY_ATTEMPTS) return { ok: false, action: 'staff', reason: 'replay attempts used up' };
  const customer = getCustomerById(row.customer_id, undefined, null);
  if (!customer || customer.whatsapp_account_id !== row.whatsapp_account_id) return { ok: false, action: 'abandon', reason: 'customer record not found for this business' };
  if (customer.automation_paused) return { ok: false, action: 'abandon', reason: 'automation is paused for this customer' };
  if (getHold(customer.id)) return { ok: false, action: 'abandon', reason: 'a person owns this conversation' };
  const settings = getAutomationSettings();
  if (!settings.autoRepliesEnabled || !settings.aiRepliesEnabled) return { ok: false, action: 'wait', reason: 'automatic AI replies are off for this business' };
  const state = customer.menu_state ?? null;
  if (state && state !== 'MAIN_MENU' && state !== 'FOLLOWUP_MENU' && !state.startsWith('SUBMENU_')) return { ok: false, action: 'abandon', reason: 'the customer moved into a guided flow' };
  if (!customer.language) return { ok: false, action: 'abandon', reason: 'language not chosen yet' };
  const inbound = db.prepare(`SELECT id, content FROM conversation_messages WHERE conversation_id = ? AND whatsapp_message_id = ? AND role = 'user' ORDER BY id LIMIT 1`).get(row.conversation_id, row.message_id) as { id: number; content: string } | undefined;
  if (!inbound || !inbound.content.trim() || inbound.content.startsWith('[')) return { ok: false, action: 'abandon', reason: 'the message text is not available' };
  const toolRan = db.prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ? AND id > ? AND tool_call_id IS NOT NULL`).get(row.conversation_id, inbound.id) as { n: number };
  if (toolRan.n > 0) return { ok: false, action: 'staff', reason: 'a tool already ran for this message; replaying could repeat its effect' };
  const answered = db.prepare(`SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ? AND id > ? AND role = 'assistant' AND direction = 'outbound' AND (metadata IS NULL OR metadata NOT LIKE '%"templateKey"%')`).get(row.conversation_id, inbound.id) as { n: number };
  if (answered.n > 0) return { ok: false, action: 'abandon', reason: 'already answered meanwhile' };
  return { ok: true, text: inbound.content };
}

/** True when at least one AI route could take a chat request right now (cooldowns and strict free-only already applied). */
export async function aiRouteAvailable(accountId: number): Promise<boolean> {
  try {
    const plan = await buildCandidates(accountId, 'chat', { wantsTools: true });
    return plan.eligible.length > 0;
  } catch {
    return false;
  }
}

/**
 * One pass: replays the eligible waiting messages through `runner`. Safe to call often (a 2-minute timer and after a provider is added);
 * a pass that finds nothing eligible costs one query.
 */
export async function runReplaySweep(
  runner: ReplayRunner,
  now: Date = new Date(),
  db: Database.Database = getDb(),
  opts: { routeAvailable?: (accountId: number) => Promise<boolean> } = {},
): Promise<ReplaySweepResult> {
  const result: ReplaySweepResult = { replayed: 0, answered: 0, abandoned: 0, needsStaff: 0, waiting: 0 };
  const rows = listReplayCandidates(REPLAY_BATCH, db);
  const newestPerCustomer = new Map<number, PendingReply>();
  for (const row of rows) newestPerCustomer.set(row.customer_id, row); // rows are oldest-first: the last one wins
  for (const row of rows) {
    if (newestPerCustomer.get(row.customer_id) !== row) {
      setPendingStatus(row.id, 'abandoned', 'a newer message from the same customer is answered instead', db);
      result.abandoned += 1;
    }
  }
  const routeOk = new Map<number, boolean>();
  for (const row of newestPerCustomer.values()) {
    const verdict = runWithAccount(row.whatsapp_account_id, () => assess(row, now, db));
    if (!verdict.ok) {
      if (verdict.action === 'wait') { result.waiting += 1; continue; }
      setPendingStatus(row.id, verdict.action === 'abandon' ? 'abandoned' : 'needs_staff', verdict.reason, db);
      if (verdict.action === 'abandon') result.abandoned += 1; else result.needsStaff += 1;
      continue;
    }
    if (!routeOk.has(row.whatsapp_account_id)) routeOk.set(row.whatsapp_account_id, await (opts.routeAvailable ?? aiRouteAvailable)(row.whatsapp_account_id));
    if (!routeOk.get(row.whatsapp_account_id)) { result.waiting += 1; continue; } // still no working AI route: nothing is spent, nothing is sent
    const claimed = claimForReplay(row.id, db);
    if (!claimed) continue;
    result.replayed += 1;
    try {
      const customer = getCustomerById(claimed.customer_id, undefined, null);
      await runner.run(claimed, customer?.reply_jid ?? null, async (knowledge) => {
        await runWithAccount(claimed.whatsapp_account_id, () => processInboundMessage(
          { waId: claimed.wa_id, messageId: `replay:${claimed.id}:${claimed.attempts}`, timestamp: now.getTime(), type: 'text', text: verdict.text, channel: claimed.channel, accountId: claimed.whatsapp_account_id, replayOf: claimed.message_id },
          { knowledge: knowledge ?? { sections: [], asPromptText: '' } },
        ));
      });
      const after = getPendingReply(claimed.message_id, db, claimed.whatsapp_account_id);
      if (after?.status === 'answered') result.answered += 1;
      else if (after?.status === 'awaiting_ai' && after.attempts >= MAX_REPLAY_ATTEMPTS) {
        setPendingStatus(after.id, 'needs_staff', 'still no AI answer after the replay attempts', db);
        result.needsStaff += 1;
      } else if (after?.status === 'replaying') {
        const status = releaseAfterFailedReplay(claimed.id, 'the replay produced no answer', MAX_REPLAY_ATTEMPTS, db);
        if (status === 'needs_staff') result.needsStaff += 1;
      }
    } catch (error) {
      const status = releaseAfterFailedReplay(claimed.id, `replay could not run: ${String((error as Error)?.message ?? error).slice(0, 160)}`, MAX_REPLAY_ATTEMPTS, db);
      if (status === 'needs_staff') result.needsStaff += 1;
      logger.warn({ customer: maskWaId(claimed.wa_id), account: claimed.whatsapp_account_id, error: String((error as Error)?.message ?? error).slice(0, 200) }, '[REPLAY] a replay could not run; it stays queued');
    }
  }
  if (result.replayed || result.abandoned || result.needsStaff) logger.info({ ...result }, '[REPLAY] sweep finished');
  return result;
}
