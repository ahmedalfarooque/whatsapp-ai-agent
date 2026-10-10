import { TOOL_NAMES } from '../config/constants';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { requestHandoff } from '../handoff/handoffRepo';

/**
 * Lets the assistant hand the conversation to a person when the customer clearly wants one in words the keyword/pattern detector
 * did not catch (any language, any phrasing). It works only through the conversation it is running in, so it can only ever
 * affect THIS customer of THIS business. The pipeline then sends the hand-over message instead of the model's own text.
 */
export const requestHumanHandoffSchema = {
  type: 'function' as const,
  function: {
    name: TOOL_NAMES.REQUEST_HUMAN_HANDOFF,
    description:
      'Hand this conversation to a real staff member. Call it ONLY when the customer clearly asks to speak to a person / human / staff member / manager, or is clearly upset and wants a person to take over. Do NOT call it for ordinary questions, for requests for a service, or when the customer merely mentions staff, an agent or an employee. After calling it, do not write anything else.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'In a few words, why the customer wants a person (their words, not an interpretation).' },
      },
      required: [],
    },
  },
};

export async function requestHumanHandoffHandler(args: unknown, context: { conversationId: number }): Promise<unknown> {
  const reason = typeof (args as { reason?: unknown })?.reason === 'string' ? (args as { reason: string }).reason.trim().slice(0, 200) : '';
  const db = getDb();
  const row = db
    .prepare('SELECT c.id AS conversationId, c.customer_id AS customerId FROM conversations c WHERE c.id = ? AND c.whatsapp_account_id = ?')
    .get(context.conversationId, currentAccountId()) as { conversationId: number; customerId: number } | undefined;
  if (!row) return { error: 'conversation_not_found' };
  const { handoff, outcome } = requestHandoff({ customerId: row.customerId, conversationId: row.conversationId, source: 'ai', reason: reason ? `Assistant: ${reason}` : 'The assistant handed the conversation to staff' });
  return {
    ok: true,
    status: handoff.state,
    repeated: outcome === 'repeated',
    note: 'A staff member has been requested. The customer will receive the hand-over message automatically; do not add any other text.',
  };
}
