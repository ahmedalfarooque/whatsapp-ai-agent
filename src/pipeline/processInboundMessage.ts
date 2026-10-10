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
import fs from 'node:fs';
import { sendTextMessage, sendDocumentMessage, sendImageMessage, ImageDeliveryUnsupportedError, DocumentDeliveryUnsupportedError } from '../whatsapp/client';
import { customerOfferMedia, MAX_IMAGE_CAPTION_CHARS, type OfferMediaItem } from '../offers/offerMedia';
import { getDeliverableCatalogue } from '../catalogues/catalogueRepo';
import type { KnowledgeBase } from '../knowledge/loader';
import { withCustomerLock } from './idempotency';
import { AiCredentialError } from '../llm/aiCredentialError';
import { MENU_IDS, detectLanguageFromScript, isHardRestart, isHumanSupportRequest, isMenuKeyword, isSubstantiveFreeText } from '../automation/menu';
import { MENU_STATES, DATA_DRIVEN_FALLBACKS, routeMenu, type RouteResult } from '../automation/menuRouter';
import { renderCustomerOffers } from '../offers/offerRepo';
import { resolveTemplate, type TemplateVars } from '../templates/templateRepo';
import { getAutomationSettings, recordReplyActivity, type ReplyActivityKind } from '../automation/settingsRepo';
import { currentAccountId, runWithAccount, LEGACY_ACCOUNT_ID } from '../accounts/accountContext';
import { isOutsideBusinessHours } from '../setup/hours';

export interface ProcessDependencies {
  /** The knowledge base of the account the message belongs to. */
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
  // The whole pipeline — customer lookup, settings, templates, offers, AI
  // context, request creation, outbox rows — runs inside the account the
  // message arrived on. Serialisation is per (account, customer): the same
  // phone talking to two businesses is two independent conversations.
  const accountId = msg.accountId ?? currentAccountId();
  return runWithAccount(accountId, () => withCustomerLock(`${accountId}:${msg.waId}`, () => processInboundMessageUnlocked(msg, deps)));
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
    // Media keeps its kind visible to staff; a caption is shown after it. Text and menu taps are stored as typed.
    content: msg.type === 'text' || msg.type === 'interactive'
      ? (msg.text ?? (msg.interactiveId ? `[${msg.interactiveId}]` : `[${msg.type}]`))
      : (msg.text ? `[${msg.type}] ${msg.text}` : `[${msg.type}]`),
    whatsappMessageId: msg.messageId,
    direction: MESSAGE_DIRECTION.INBOUND,
    messageType: msg.type,
  });
}

/** Protocol-level noise (reactions, edits, receipts): not worth a row in the conversation or the activity list. */
const SILENT_UNSTORED_TYPES = new Set(['reaction', 'other']);

/** While the AI key is unusable, each customer hears the generic apology at most once per window. */
const CREDENTIAL_FALLBACK_COOLDOWN_MS = 10 * 60_000;
const lastCredentialFallback = new Map<string, number>();

function allowCredentialFallback(accountId: number, waId: string, now = Date.now()): boolean {
  const key = `${accountId}:${waId}`;
  const last = lastCredentialFallback.get(key) ?? 0;
  if (now - last < CREDENTIAL_FALLBACK_COOLDOWN_MS) return false;
  lastCredentialFallback.set(key, now);
  if (lastCredentialFallback.size > 2000) lastCredentialFallback.delete(lastCredentialFallback.keys().next().value as string);
  return true;
}

/** Test hook. */
export function resetCredentialFallbackThrottle(): void {
  lastCredentialFallback.clear();
}

async function processInboundMessageUnlocked(msg: InboundMessage, deps: ProcessDependencies): Promise<void> {
  const maskedId = maskWaId(msg.waId);
  const channel = msg.channel ?? 'cloud';
  const settings = getAutomationSettings();

  let customer = getOrCreateCustomer(msg.waId, msg.contactName);
  const conversation = getOrCreateActiveConversation(customer.id);
  const language: CustomerLanguage = customer.language ?? 'en';
  const ctx: ReplyContext = { msg, customer, conversationId: conversation.id, channel, language };

  // Only plain text (and menu taps) enters the automatic conversation. A voice note, audio, photo, video, document, sticker,
  // location, reaction... is recorded for the team and NEVER answered: no apology, no menu, no AI. Staff can still reply by hand.
  if (msg.type !== 'text' && msg.type !== 'interactive') {
    logger.info({ waId: maskedId, type: msg.type }, 'non-text inbound message recorded; no automatic reply');
    if (!SILENT_UNSTORED_TYPES.has(msg.type)) {
      storeInbound(conversation.id, msg);
      recordReplyActivity({ customerId: customer.id, waId: msg.waId, channel, kind: 'suppressed', detail: `${msg.type} message — not answered automatically` });
    }
    return;
  }

  if (!settings.autoRepliesEnabled) {
    recordReplyActivity({ customerId: customer.id, waId: msg.waId, channel, kind: 'suppressed', detail: 'Automatic replies are disabled' });
    logger.info({ waId: maskedId }, 'automatic replies disabled — inbound message stored only');
    if (msg.text || msg.interactiveId) storeInbound(conversation.id, msg);
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
    await replyOutOfHours(ctx);
    return;
  }

  // A brand-new customer whose very first message is a real question gets an ANSWER (in the language they wrote), not a language prompt.
  if (msg.type === 'text' && !customer.language && settings.aiRepliesEnabled && isSubstantiveFreeText(msg.text)) {
    const detected = detectLanguageFromScript(msg.text);
    if (detected) {
      customer = setCustomerLanguage(customer.id, detected);
      customer = setCustomerMenuState(customer.id, MENU_STATES.MAIN_MENU, null);
      ctx.customer = customer;
      ctx.language = detected;
    }
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
  let failureDetail = 'AI failed; fallback sent';
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
    const credentialProblem = error instanceof AiCredentialError ? error : null;
    logger.error(
      { waId: maskedId, errorName: (error as Error)?.name, errorMessage: String((error as Error)?.message ?? error).slice(0, 200), credentialReason: credentialProblem?.reason },
      'agent loop failed for inbound message',
    );
    if (credentialProblem) {
      // The provider key is unusable: every message would fail the same way. Tell the customer once in a while, not on every message.
      if (!allowCredentialFallback(currentAccountId(), msg.waId)) {
        recordReplyActivity({ customerId: customer.id, waId: msg.waId, channel, kind: 'suppressed', detail: `AI credential problem (${credentialProblem.reason}) — apology already sent recently` });
        return;
      }
      failureDetail = `AI credential problem (${credentialProblem.reason}): fallback sent. Enter a valid OpenRouter key in the dashboard (Providers).`;
    }
    kind = 'error';
    finalText = resolveTemplate('fallback_error', language);
    appendMessage(conversation.id, { role: 'assistant', content: finalText, direction: MESSAGE_DIRECTION.OUTBOUND });
  }

  try {
    await sendTextMessage(msg.waId, finalText);
    recordReplyActivity({ customerId: customer.id, waId: msg.waId, channel, kind, detail: kind === 'error' ? failureDetail : undefined });
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
    const resolved = resolveDataDrivenKey(key, language, vars);
    // The Offers option (every business's menu routes to this one template) — nothing here is specific to any business.
    if (resolved === OFFERS_LIST_TEMPLATE) await deliverOffers(nextCtx, resolved, route.kind, vars);
    else await replyTemplate(nextCtx, resolved, route.kind, vars);
  }
  if (route.catalogueId !== undefined) await deliverCatalogue(nextCtx, route.catalogueId);
  if (route.kind === 'human_handoff') await replyOutOfHours(nextCtx);
}

const OFFERS_LIST_TEMPLATE = 'prices_offers_list';

interface LoadedOfferFile {
  item: OfferMediaItem;
  bytes: Buffer;
}

/**
 * The Offers reply. When an offer has a picture the customer gets ONE WhatsApp message: the first picture with the complete offers
 * text as its caption (so there is never a separate text bubble beside it). Any further pictures and supporting files follow as
 * their own messages — each is a different file, never the same offer twice. Everything falls back to plain text so the customer
 * always receives the offers: no picture, a text longer than a caption may hold, a connection that cannot carry media, or a send
 * failure. Only THIS business's offers and documents are read; a missing or unreadable file is skipped with a safe log line (offer
 * and document ids, never a path) and never crashes anything.
 */
async function deliverOffers(ctx: ReplyContext, key: string, kind: ReplyActivityKind, vars: TemplateVars): Promise<void> {
  const accountId = currentAccountId();
  const { items, skipped } = customerOfferMedia(ctx.language);
  for (const s of skipped) {
    logger.warn({ account: accountId, offerId: s.offerId, documentId: s.documentId, slot: s.slot, reason: s.reason }, 'offer attachment not delivered');
  }
  if (skipped.length > 0) {
    recordReplyActivity({ customerId: ctx.customer.id, waId: ctx.msg.waId, channel: ctx.channel, kind: 'error', detail: `${skipped.length} offer attachment(s) could not be sent (${[...new Set(skipped.map((s) => s.reason))].join(', ')})` });
  }

  const files: LoadedOfferFile[] = [];
  for (const item of items) {
    try {
      files.push({ item, bytes: fs.readFileSync(item.path) });
    } catch {
      logger.warn({ account: accountId, offerId: item.offerId, documentId: item.documentId }, 'offer attachment could not be read at send time');
      recordReplyActivity({ customerId: ctx.customer.id, waId: ctx.msg.waId, channel: ctx.channel, kind: 'error', detail: `Offer attachment could not be read (offer ${item.offerId})` });
    }
  }

  const text = resolveTemplate(key, ctx.language, { name: ctx.customer.display_name ?? ctx.msg.contactName ?? '', ...vars });
  let mediaUnsupported = false;
  let captioned: LoadedOfferFile | undefined;
  let attempted: LoadedOfferFile | undefined; // a picture whose send was tried is never sent a second time, even if it failed
  const firstImage = files.find((f) => f.item.kind === 'image');
  if (firstImage && text.length <= MAX_IMAGE_CAPTION_CHARS) {
    attempted = firstImage;
    const outcome = await sendOfferFile(ctx, firstImage, text, { templateKey: key, detail: 'Offers sent as one picture message (text in the caption)' });
    if (outcome === 'sent') captioned = firstImage;
    else if (outcome === 'unsupported') mediaUnsupported = true;
  } else if (firstImage) {
    logger.info({ account: accountId, length: text.length, limit: MAX_IMAGE_CAPTION_CHARS }, 'offers text is longer than a picture caption can hold; sending it as text plus the pictures');
  }

  // No caption message went out: the offers text goes as an ordinary message so the customer always receives it.
  if (!captioned) await reply(ctx, text, kind, key);

  for (const file of files) {
    if (file === attempted) continue;
    if (mediaUnsupported) break;
    const outcome = await sendOfferFile(ctx, file, file.item.title, { templateKey: 'offer_media', detail: `Offer ${file.item.kind} sent: ${file.item.title}` });
    if (outcome === 'unsupported') mediaUnsupported = true;
  }
}

/** Sends one offer picture/file with the given caption. 'unsupported' = this connection cannot carry media at all. */
async function sendOfferFile(
  ctx: ReplyContext,
  file: LoadedOfferFile,
  caption: string,
  record: { templateKey: string; detail: string },
): Promise<'sent' | 'unsupported' | 'failed'> {
  const { item, bytes } = file;
  const payload = { fileName: item.fileName, mimeType: item.mimeType, bytes, caption };
  try {
    if (item.kind === 'image') await sendImageMessage(ctx.msg.waId, payload);
    else await sendDocumentMessage(ctx.msg.waId, payload);
  } catch (error) {
    if (error instanceof ImageDeliveryUnsupportedError || error instanceof DocumentDeliveryUnsupportedError) {
      // This connection (the Meta Cloud API one) cannot carry media: the offer text still goes as plain text.
      logger.warn({ account: currentAccountId(), channel: ctx.channel }, 'this WhatsApp connection cannot deliver offer media');
      recordReplyActivity({ customerId: ctx.customer.id, waId: ctx.msg.waId, channel: ctx.channel, kind: 'error', detail: 'Offer attachments need the QR (linked device) connection' });
      return 'unsupported';
    }
    logger.error({ account: currentAccountId(), offerId: item.offerId, documentId: item.documentId, errorName: (error as Error)?.name }, 'offer attachment could not be sent');
    recordReplyActivity({ customerId: ctx.customer.id, waId: ctx.msg.waId, channel: ctx.channel, kind: 'error', detail: `Offer attachment could not be sent (offer ${item.offerId})` });
    return 'failed';
  }
  appendMessage(ctx.conversationId, {
    role: 'assistant',
    content: `[${item.kind}] ${caption}`,
    direction: MESSAGE_DIRECTION.OUTBOUND,
    messageType: item.kind,
    metadata: { offerId: item.offerId, templateKey: record.templateKey },
  });
  recordReplyActivity({ customerId: ctx.customer.id, waId: ctx.msg.waId, channel: ctx.channel, kind: 'rule', templateKey: record.templateKey, detail: record.detail });
  return 'sent';
}

/**
 * Sends the catalogue PDF the customer picked, through the same WhatsApp connection the message arrived on, with a short
 * caption from the (editable) reply templates. Only an enabled catalogue of THIS business can be sent; if the file is gone or
 * cannot be delivered the customer gets a plain apology instead — never a fake link, a path or an internal id.
 */
async function deliverCatalogue(ctx: ReplyContext, catalogueId: number): Promise<void> {
  const maskedId = maskWaId(ctx.msg.waId);
  const file = getDeliverableCatalogue(catalogueId);
  if (!file) {
    await replyTemplate(ctx, 'catalogue_unavailable', 'rule', {}, 'Catalogue no longer available');
    return;
  }
  const caption = resolveTemplate('catalogue_delivery', ctx.language, { name: ctx.customer.display_name ?? ctx.msg.contactName ?? '', catalogue: file.title });
  try {
    await sendDocumentMessage(ctx.msg.waId, { fileName: file.fileName, mimeType: file.mimeType, bytes: fs.readFileSync(file.path), caption });
  } catch (error) {
    logger.error({ waId: maskedId, error }, 'catalogue could not be sent');
    recordReplyActivity({ customerId: ctx.customer.id, waId: ctx.msg.waId, channel: ctx.channel, kind: 'error', detail: 'Catalogue could not be sent' });
    await replyTemplate(ctx, 'catalogue_unavailable', 'rule', {}, 'Catalogue could not be sent');
    return;
  }
  appendMessage(ctx.conversationId, {
    role: 'assistant',
    content: `[document] ${file.title}\n${caption}`,
    direction: MESSAGE_DIRECTION.OUTBOUND,
    messageType: 'document',
    metadata: { templateKey: 'catalogue_delivery' },
  });
  recordReplyActivity({ customerId: ctx.customer.id, waId: ctx.msg.waId, channel: ctx.channel, kind: 'rule', templateKey: 'catalogue_delivery', detail: `Catalogue sent: ${file.title}` });
  await replyTemplate(ctx, 'catalogue_after');
}

/**
 * After a hand-off to staff outside the business's own opening hours, tell the customer when someone will be back.
 * Only for businesses that entered hours (never guessed), and only the non-original businesses have this template.
 */
async function replyOutOfHours(ctx: ReplyContext): Promise<void> {
  if (currentAccountId() === LEGACY_ACCOUNT_ID) return;
  if (isOutsideBusinessHours(getBusinessSettings()) !== true) return;
  try {
    await replyTemplate(ctx, 'out_of_hours', 'human_handoff', {}, 'Outside opening hours');
  } catch (error) {
    logger.warn({ error }, 'could not send the out-of-hours reply');
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
