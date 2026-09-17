import { getBusinessSettings } from '../config/businessSettings';
import { logger, maskWaId } from '../logger';
import { GENERIC_ERROR_REPLY, MESSAGE_DIRECTION } from '../config/constants';
import type { InboundMessage } from '../webhook/parseInboundPayload';
import { getOrCreateCustomer, setCustomerLanguage, type Customer, type CustomerLanguage } from '../memory/customerRepo';
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
import { sendTextMessage, sendInteractiveMessage } from '../whatsapp/client';
import type { KnowledgeBase } from '../knowledge/loader';
import { withCustomerLock } from './idempotency';
import {
  MENU_IDS,
  buildLanguageSelectionMessage,
  buildWelcomeText,
  buildMainMenuMessage,
  buildCategoryMessage,
  buildLocationMessage,
  detectLanguageFromText,
  isMenuKeyword,
  isChangeLanguageKeyword,
} from '../automation/menu';

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

  if (msg.type !== 'text' && msg.type !== 'interactive') {
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
  if (msg.type === 'text' && !msg.text) {
    return;
  }

  let customer = getOrCreateCustomer(msg.waId, msg.contactName);
  const conversation = getOrCreateActiveConversation(customer.id);

  if (msg.type === 'text' && isRestartCommand(msg.text)) {
    appendMessage(conversation.id, {
      role: 'user',
      content: msg.text as string,
      whatsappMessageId: msg.messageId,
      direction: MESSAGE_DIRECTION.INBOUND,
      messageType: msg.type,
    });
    clearBookingSession(conversation.id);
    customer = setCustomerLanguage(customer.id, null);
    const freshConversation = resetConversation(customer.id);
    appendMessage(freshConversation.id, {
      role: 'assistant',
      content: RESTART_CONFIRMATION,
      direction: MESSAGE_DIRECTION.OUTBOUND,
    });
    await sendTextMessage(msg.waId, RESTART_CONFIRMATION);
    await sendInteractiveMessage(msg.waId, buildLanguageSelectionMessage());
    logger.info({ waId: maskedId }, 'conversation restarted by customer command, language reset');
    return;
  }

  const handledByMenu = await handleLanguageAndMenu(msg, customer, maskedId);
  if (handledByMenu) return;

  appendMessage(conversation.id, {
    role: 'user',
    content: msg.text as string,
    whatsappMessageId: msg.messageId,
    direction: MESSAGE_DIRECTION.INBOUND,
    messageType: msg.type,
  });

  const history = getRecentMessages(conversation.id, getBusinessSettings().conversationHistoryLimit);
  const systemPrompt = buildSystemPrompt(deps.knowledge, customer.language ?? undefined);

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

/**
 * Language selection + top-level menu navigation, handled entirely outside
 * the AI loop so it never depends on the LLM and can't drift from the fixed
 * set of menu IDs. Returns true when this function fully handled the inbound
 * message (menu/language interaction) and the caller should stop — false
 * means the message is free text meant for the AI agent loop.
 */
async function handleLanguageAndMenu(
  msg: InboundMessage,
  customer: Customer,
  maskedId: string,
): Promise<boolean> {
  let language: CustomerLanguage | null = customer.language;

  if (!language) {
    if (msg.interactiveId === MENU_IDS.LANG_EN) {
      language = 'en';
    } else if (msg.interactiveId === MENU_IDS.LANG_AR) {
      language = 'ar';
    } else if (msg.type === 'text') {
      language = detectLanguageFromText(msg.text) ?? null;
    }

    if (!language) {
      await sendInteractiveMessage(msg.waId, buildLanguageSelectionMessage());
      return true;
    }

    setCustomerLanguage(customer.id, language);
    await sendTextMessage(msg.waId, buildWelcomeText(language, customer.display_name ?? msg.contactName));
    await sendInteractiveMessage(msg.waId, buildMainMenuMessage(language));
    logger.info({ waId: maskedId, language }, 'customer selected language, showed main menu');
    return true;
  }

  if (msg.interactiveId) {
    switch (msg.interactiveId) {
      case MENU_IDS.CATEGORY_AUDIO:
        await sendInteractiveMessage(msg.waId, buildCategoryMessage(language, 'audio'));
        break;
      case MENU_IDS.CATEGORY_ACCESSORIES:
        await sendInteractiveMessage(msg.waId, buildCategoryMessage(language, 'accessories'));
        break;
      case MENU_IDS.CATEGORY_CARE:
        await sendInteractiveMessage(msg.waId, buildCategoryMessage(language, 'care'));
        break;
      case MENU_IDS.PRICES:
        await sendInteractiveMessage(msg.waId, buildCategoryMessage(language, 'prices'));
        break;
      case MENU_IDS.LOCATION:
        await sendInteractiveMessage(msg.waId, buildLocationMessage(language));
        break;
      case MENU_IDS.CHANGE_LANGUAGE:
        setCustomerLanguage(customer.id, null);
        await sendInteractiveMessage(msg.waId, buildLanguageSelectionMessage());
        break;
      case MENU_IDS.MAIN_MENU:
      default:
        await sendInteractiveMessage(msg.waId, buildMainMenuMessage(language));
        break;
    }
    return true;
  }

  if (msg.type === 'text') {
    if (isChangeLanguageKeyword(msg.text, language)) {
      setCustomerLanguage(customer.id, null);
      await sendInteractiveMessage(msg.waId, buildLanguageSelectionMessage());
      return true;
    }
    if (isMenuKeyword(msg.text, language)) {
      await sendInteractiveMessage(msg.waId, buildMainMenuMessage(language));
      return true;
    }
  }

  return false;
}
