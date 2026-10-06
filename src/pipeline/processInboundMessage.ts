import { getBusinessSettings } from '../config/businessSettings';
import { logger, maskWaId } from '../logger';
import { MESSAGE_DIRECTION } from '../config/constants';
import type { InboundMessage } from '../webhook/parseInboundPayload';
import {
  getOrCreateCustomer,
  setCustomerLanguage,
  setCustomerMenuState,
  getCustomerFlowData,
  pauseCustomerAutomation,
  resumeCustomerAutomation,
  type Customer,
  type CustomerLanguage,
} from '../memory/customerRepo';
import {
  getOrCreateActiveConversation,
  appendMessage,
  getRecentMessages,
  resetConversation,
} from '../memory/conversationRepo';
import { clearBookingSession } from '../memory/bookingSessionRepo';
import { createCustomerRequest } from '../memory/customerRequestRepo';
import { notifyBusinessNewRequest } from '../requests/requestService';
import { isRestartCommand } from '../restart/isRestartCommand';
import { buildSystemPrompt } from '../llm/buildSystemPrompt';
import { runAgentLoop } from '../llm/agentLoop';
import { sendTextMessage } from '../whatsapp/client';
import type { KnowledgeBase } from '../knowledge/loader';
import { withCustomerLock } from './idempotency';
import { MENU_IDS, isHardRestart, isHumanSupportRequest, isMenuKeyword } from '../automation/menu';
import { MENU_STATES, DATA_DRIVEN_FALLBACKS, routeMenu, type RouteResult } from '../automation/menuRouter';
import { renderCustomerOffers } from '../offers/offerRepo';
import { resolveTemplate, type TemplateVars } from '../templates/templateRepo';
import { getAutomationSettings, recordReplyActivity, type ReplyActivityKind } from '../automation/settingsRepo';

export interface ProcessDependencies {
  knowledge: KnowledgeBase;
}

/**
 * Full processing pipeline for one inbound WhatsApp message: resolve the
 * customer, store the message, apply automation settings and human-handoff
 * pauses, handle restart commands, run the language-first guided menu
 * (templates only — no generated text), and hand free text to the AI
 * tool-calling loop. Every outbound bubble is persisted to the conversation
 * so the dashboard shows exactly what the customer received. Runs serialized
 * per customer via withCustomerLock; replies leave through whatever transport
 * the inbound message arrived on.
 */
export async function processInboundMessage(msg: InboundMessage, deps: ProcessDependencies): Promise<void> {
  return withCustomerLock(msg.waId, () => processInboundMessageUnlocked(msg, deps));
}

interface ReplyContext {
  msg: InboundMessage;
  customer: Customer;
  conversationId: number;
  channel: string;
  language: CustomerLanguage;
}

/** Persists an outbound bubble, sends it, and records the activity. One call = one WhatsApp message. */
async function reply(ctx: ReplyContext, text: string, kind: ReplyActivityKind, templateKey?: string, detail?: string): Promise<void> {
  appendMessage(ctx.conversationId, {
    role: 'assistant',
    content: text,
    direction: MESSAGE_DIRECTION.OUTBOUND,
    messageType: 'text',
    metadata: templateKey ? { templateKey } : undefined,
  });
  await sendTextMessage(ctx.msg.waId, text);
  recordReplyActivity({ customerId: ctx.customer.id, waId: ctx.msg.waId, channel: ctx.channel, kind, templateKey, detail });
}

async function replyTemplate(ctx: ReplyContext, key: string, kind: ReplyActivityKind = 'rule', vars: TemplateVars = {}, detail?: string): Promise<void> {
  const text = resolveTemplate(key, ctx.language, { name: ctx.customer.display_name ?? ctx.msg.contactName ?? '', ...vars });
  await reply(ctx, text, kind, key, detail);
}

function storeInbound(conversationId: number, msg: InboundMessage): void {
  appendMessage(conversationId, {
    role: 'user',
    content: msg.text ?? (msg.interactiveId ? `[${msg.interactiveId}]` : `[${msg.type}]`),
    whatsappMessageId: msg.messageId,
    direction: MESSAGE_DIRECTION.INBOUND,
    messageType: msg.type,
  });
}

async function processInboundMessageUnlocked(msg: InboundMessage, deps: ProcessDependencies): Promise<void> {
  const maskedId = maskWaId(msg.waId);
  const channel = msg.channel ?? 'cloud';
  const settings = getAutomationSettings();

  let customer = getOrCreateCustomer(msg.waId, msg.contactName);
  const conversation = getOrCreateActiveConversation(customer.id);
  const language: CustomerLanguage = customer.language ?? 'en';
  const ctx: ReplyContext = { msg, customer, conversationId: conversation.id, channel, language };

  if (!settings.autoRepliesEnabled) {
    recordReplyActivity({ customerId: customer.id, waId: msg.waId, channel, kind: 'suppressed', detail: 'Automatic replies are disabled' });
    logger.info({ waId: maskedId }, 'automatic replies disabled — inbound message stored only');
    if (msg.text || msg.interactiveId) storeInbound(conversation.id, msg);
    return;
  }

  if (msg.type !== 'text' && msg.type !== 'interactive') {
    logger.info({ waId: maskedId, type: msg.type }, 'ignoring unsupported inbound message type');
    storeInbound(conversation.id, msg);
    try {
      await replyTemplate(ctx, 'unsupported_message');
    } catch (error) {
      logger.error({ waId: maskedId, error }, 'failed to notify customer of unsupported message type');
    }
    return;
  }
  if (msg.type === 'text' && !msg.text) return;

  storeInbound(conversation.id, msg);

  // Restart: forget language, menu position, and booking state; the next turn starts from the welcome.
  if (msg.type === 'text' && (isRestartCommand(msg.text) || isHardRestart(msg.text))) {
    clearBookingSession(conversation.id);
    customer = setCustomerLanguage(customer.id, null);
    setCustomerMenuState(customer.id, null, null);
    const fresh = resetConversation(customer.id);
    const restartCtx: ReplyContext = { ...ctx, customer, conversationId: fresh.id };
    await replyTemplate(restartCtx, 'restart_confirmation');
    await replyTemplate(restartCtx, 'language_selection');
    setCustomerMenuState(customer.id, MENU_STATES.AWAITING_LANGUAGE, null);
    logger.info({ waId: maskedId }, 'conversation restarted by customer command, language reset');
    return;
  }

  // Human takeover: stay silent until staff resume or the customer asks for the menu again.
  if (customer.automation_paused === 1) {
    if (msg.interactiveId === MENU_IDS.MAIN_MENU || (msg.type === 'text' && isMenuKeyword(msg.text))) {
      customer = resumeCustomerAutomation(customer.id);
      setCustomerMenuState(customer.id, MENU_STATES.MAIN_MENU, null);
      await replyTemplate({ ...ctx, customer }, 'main_menu', 'rule', {}, 'Customer returned from human support');
      return;
    }
    recordReplyActivity({ customerId: customer.id, waId: msg.waId, channel, kind: 'suppressed', detail: 'Human support mode — automation paused for this customer' });
    logger.info({ waId: maskedId }, 'automation paused for customer (human support mode)');
    return;
  }

  if (msg.type === 'text' && isHumanSupportRequest(msg.text)) {
    pauseCustomerAutomation(customer.id, 'Customer requested a human');
    setCustomerMenuState(customer.id, MENU_STATES.MAIN_MENU, null);
    await replyTemplate(ctx, 'human_support', 'human_handoff');
    return;
  }

  if (settings.ruleRepliesEnabled) {
    const route = routeMenu({ text: msg.text, interactiveId: msg.interactiveId, customer });
    if (route) {
      await applyRoute(ctx, route);
      return;
    }
  }

  // Free text → AI agent loop (OpenRouter tool calling), unchanged behaviour.
  if (!settings.aiRepliesEnabled) {
    await replyTemplate(ctx, 'ai_disabled');
    return;
  }

  const history = getRecentMessages(conversation.id, getBusinessSettings().conversationHistoryLimit);
  const systemPrompt = buildSystemPrompt(deps.knowledge, customer.language ?? undefined);

  let finalText: string;
  let kind: 'ai' | 'error' = 'ai';
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
    kind = 'error';
    finalText = resolveTemplate('fallback_error', language);
    appendMessage(conversation.id, { role: 'assistant', content: finalText, direction: MESSAGE_DIRECTION.OUTBOUND });
  }

  try {
    await sendTextMessage(msg.waId, finalText);
    recordReplyActivity({ customerId: customer.id, waId: msg.waId, channel, kind, detail: kind === 'error' ? 'AI failed; fallback sent' : undefined });
  } catch (error) {
    recordReplyActivity({ customerId: customer.id, waId: msg.waId, channel, kind: 'error', detail: 'Reply could not be sent' });
    logger.error({ waId: maskedId, error }, 'failed to send reply to customer after processing');
  }
}

/** Applies a router decision: state/language changes first, then the templates as separate bubbles, in order. */
async function applyRoute(ctx: ReplyContext, route: RouteResult): Promise<void> {
  let customer = ctx.customer;
  if (route.language !== undefined) customer = setCustomerLanguage(customer.id, route.language);
  if (route.state !== undefined || route.flowData !== undefined) {
    const flowData = route.flowData === undefined ? getCustomerFlowData(customer) : route.flowData;
    customer = setCustomerMenuState(customer.id, route.state === undefined ? customer.menu_state : route.state, flowData);
  }
  if (route.kind === 'human_handoff') customer = pauseCustomerAutomation(customer.id, 'Customer chose "Talk to staff"');

  const vars: TemplateVars = { ...route.vars };
  if (route.request) {
    const request = createCustomerRequest({ customerId: customer.id, waId: ctx.msg.waId, kind: route.request.kind, payload: route.request.payload });
    vars.reference = request.reference;
    logger.info({ waId: maskWaId(ctx.msg.waId), kind: route.request.kind, reference: request.reference }, 'customer request recorded from WhatsApp menu');
    try {
      notifyBusinessNewRequest(request);
    } catch (error) {
      logger.error({ error, reference: request.reference }, 'could not queue the staff alert for a new request');
    }
  }

  const language: CustomerLanguage = (route.language ?? customer.language) || 'en';
  const nextCtx: ReplyContext = { ...ctx, customer, language };
  for (const key of route.send) {
    await replyTemplate(nextCtx, resolveDataDrivenKey(key, language, vars), route.kind, vars);
  }
}

/** Swaps a data-driven template for its fallback when there is no live data to show (e.g. no offers). */
export function resolveDataDrivenKey(key: string, language: CustomerLanguage, vars: TemplateVars): string {
  const rule = DATA_DRIVEN_FALLBACKS[key];
  if (!rule) return key;
  const offers = vars.offers ?? renderCustomerOffers(language);
  if (!offers.trim()) return rule.fallback;
  vars.offers = offers;
  return key;
}
