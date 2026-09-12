import { getBusinessSettings } from '../config/businessSettings';
import { logger, maskWaId } from '../logger';
import { GENERIC_ERROR_REPLY, MESSAGE_DIRECTION } from '../config/constants';
import type { InboundMessage } from '../webhook/parseInboundPayload';
import { getOrCreateCustomer } from '../memory/customerRepo';
import {
  getOrCreateActiveConversation,
  appendMessage,
  getRecentMessages,
  resetConversation,
} from '../memory/conversationRepo';
import { clearBookingSession } from '../memory/bookingSessionRepo';
import { isRestartCommand } from '../restart/isRestartCommand';
import { buildSystemPrompt } from '../llm/buildSystemPrompt';
import { runAgentLoop } from '../llm/agentLoop';
import { sendTextMessage } from '../whatsapp/client';
import type { KnowledgeBase } from '../knowledge/loader';
import { withCustomerLock } from './idempotency';

export interface ProcessDependencies {
  knowledge: KnowledgeBase;
}

const RESTART_CONFIRMATION =
  "Done — I've started a fresh conversation. How can I help you?";

/**
 * Full processing pipeline for one inbound WhatsApp message: resolve
 * customer identity from the WhatsApp number, handle restart commands,
 * persist the message, run the LLM tool-calling loop, persist and send the
 * reply. Runs serialized per-customer via withCustomerLock to avoid race
 * conditions from concurrent/duplicate deliveries.
 */
export async function processInboundMessage(
  msg: InboundMessage,
  deps: ProcessDependencies,
): Promise<void> {
  return withCustomerLock(msg.waId, () => processInboundMessageUnlocked(msg, deps));
}

async function processInboundMessageUnlocked(
  msg: InboundMessage,
  deps: ProcessDependencies,
): Promise<void> {
  const maskedId = maskWaId(msg.waId);

  if (msg.type !== 'text' || !msg.text) {
    logger.info({ waId: maskedId, type: msg.type }, 'ignoring unsupported inbound message type');
    try {
      await sendTextMessage(
        msg.waId,
        "I can currently only read text messages — could you send that as text?",
      );
    } catch (error) {
      logger.error({ waId: maskedId, error }, 'failed to notify customer of unsupported message type');
    }
    return;
  }

  const customer = getOrCreateCustomer(msg.waId, msg.contactName);
  const conversation = getOrCreateActiveConversation(customer.id);

  if (isRestartCommand(msg.text)) {
    appendMessage(conversation.id, {
      role: 'user',
      content: msg.text,
      whatsappMessageId: msg.messageId,
      direction: MESSAGE_DIRECTION.INBOUND,
      messageType: msg.type,
    });
    clearBookingSession(conversation.id);
    const freshConversation = resetConversation(customer.id);
    appendMessage(freshConversation.id, {
      role: 'assistant',
      content: RESTART_CONFIRMATION,
      direction: MESSAGE_DIRECTION.OUTBOUND,
    });
    await sendTextMessage(msg.waId, RESTART_CONFIRMATION);
    logger.info({ waId: maskedId }, 'conversation restarted by customer command');
    return;
  }

  appendMessage(conversation.id, {
    role: 'user',
    content: msg.text,
    whatsappMessageId: msg.messageId,
    direction: MESSAGE_DIRECTION.INBOUND,
    messageType: msg.type,
  });

  const history = getRecentMessages(conversation.id, getBusinessSettings().conversationHistoryLimit);
  const systemPrompt = buildSystemPrompt(deps.knowledge);

  let finalText: string;
  try {
    const loopResult = await runAgentLoop({ systemPrompt, history, conversationId: conversation.id });
    finalText = loopResult.finalText;

    for (const generated of loopResult.generatedMessages) {
      appendMessage(conversation.id, {
        role: generated.role,
        content: generated.content,
        toolCallId: generated.toolCallId,
        toolName: generated.toolName,
        direction: generated.role === 'assistant' ? MESSAGE_DIRECTION.OUTBOUND : undefined,
      });
    }
  } catch (error) {
    logger.error({ waId: maskedId, error }, 'agent loop failed for inbound message');
    finalText = GENERIC_ERROR_REPLY;
    appendMessage(conversation.id, {
      role: 'assistant',
      content: finalText,
      direction: MESSAGE_DIRECTION.OUTBOUND,
    });
  }

  try {
    await sendTextMessage(msg.waId, finalText);
  } catch (error) {
    logger.error({ waId: maskedId, error }, 'failed to send reply to customer after processing');
  }
}
