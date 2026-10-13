import { getBusinessSettings } from '../config/businessSettings';
import { logger, maskWaId } from '../logger';
import { MESSAGE_DIRECTION } from '../config/constants';
import type { InboundMessage } from '../webhook/parseInboundPayload';
import {
  getOrCreateCustomer,
  setCustomerLanguage,
  setCustomerMenuState,
  getCustomerFlowData,
  getCustomerById,
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
import { renderPublishedProjects } from '../realestate/realEstateRepo';
import { redactSensitiveText } from '../realestate/leadFields';
import { accountHasFeature, FEATURES } from '../accounts/accountFeatures';
import { runAgentLoop } from '../llm/agentLoop';
import { IMAGE_ANALYSIS_TOOL, analyzeImage, imageContextLine, type ImageAnalysis } from '../llm/vision';
import fs from 'node:fs';
import { sendTextMessage, sendDocumentMessage, sendImageMessage, ImageDeliveryUnsupportedError, DocumentDeliveryUnsupportedError } from '../whatsapp/client';
import { customerOfferMedia, MAX_IMAGE_CAPTION_CHARS, type OfferMediaItem } from '../offers/offerMedia';
import { getDeliverableCatalogue } from '../catalogues/catalogueRepo';
import type { KnowledgeBase } from '../knowledge/loader';
import { withCustomerLock } from './idempotency';
import { AiCredentialError } from '../llm/aiCredentialError';
import { AiResponseError } from '../llm/aiResponseError';
import { env } from '../config/env';
import { MENU_IDS, detectLanguageFromScript, isHardRestart, isMenuKeyword, isSubstantiveFreeText } from '../automation/menu';
import { MENU_STATES, DATA_DRIVEN_FALLBACKS, routeMenu, type RouteResult } from '../automation/menuRouter';
import { renderCustomerOffers } from '../offers/offerRepo';
import { resolveTemplate, type TemplateVars } from '../templates/templateRepo';
import { getAutomationSettings, recordReplyActivity, type ReplyActivityKind } from '../automation/settingsRepo';
import { currentAccountId, runWithAccount, LEGACY_ACCOUNT_ID } from '../accounts/accountContext';
import { isOutsideBusinessHours } from '../setup/hours';
import { getMenuTables } from '../automation/menuConfig';
import { runCart } from '../cart/cartFlow';
import { isCartState } from '../cart/cartStates';
import { detectHumanHandoffIntent } from '../handoff/intent';
import { customerLeavesHold, getHold, requestHandoff, type Handoff } from '../handoff/handoffRepo';

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
  // The last line of defence for human takeover: whatever path got here, a customer held for staff is never answered automatically
  // (the hand-over acknowledgement itself is the one automatic message allowed).
  if (kind !== 'human_handoff' && suppressedByHandoff(ctx)) return;
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

/**
 * True (and the reason recorded) when a human now owns this customer. Read fresh from the database every time it matters, so a
 * takeover pressed while a reply was being prepared is honoured: the reply is dropped instead of sent.
 */
function suppressedByHandoff(ctx: ReplyContext, hold: Handoff | null = getHold(ctx.customer.id)): boolean {
  if (!hold) return false;
  recordReplyActivity({ customerId: ctx.customer.id, waId: ctx.msg.waId, channel: ctx.channel, kind: 'suppressed', detail: `Human handoff (${hold.state}) — no automatic reply` });
  logger.info({ waId: maskWaId(ctx.msg.waId), handoffId: hold.id, state: hold.state }, 'automatic reply withheld: a human owns this conversation');
  return true;
}

function inGuidedFlow(state: string | null): boolean {
  if (!state) return false;
  if (isCartState(state)) return true;
  return Object.values(getMenuTables().flows).some((flow) => state.startsWith(flow.statePrefix));
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

function withoutSensitiveValues(msg: InboundMessage): InboundMessage {
  if (msg.type !== 'text' || !msg.text || !accountHasFeature(currentAccountId(), FEATURES.REAL_ESTATE)) return msg;
  const cleaned = redactSensitiveText(msg.text);
  if (!cleaned.redacted) return msg;
  logger.info({ waId: maskWaId(msg.waId) }, 'sensitive value removed from an inbound message before it was stored or sent to the AI');
  return { ...msg, text: cleaned.text };
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

async function processInboundMessageUnlocked(inbound: InboundMessage, deps: ProcessDependencies): Promise<void> {
  // A business with the real estate add-on never keeps or forwards an IBAN, card number or national ID that a customer typed into the chat:
  // it is replaced here, before the message is stored, routed or sent to the AI provider (the customer is told not to share them).
  const msg = withoutSensitiveValues(inbound);
  const maskedId = maskWaId(msg.waId);
  const channel = msg.channel ?? 'cloud';
  const settings = getAutomationSettings();

  let customer = getOrCreateCustomer(msg.waId, msg.contactName);
  const conversation = getOrCreateActiveConversation(customer.id);
  const language: CustomerLanguage = customer.language ?? 'en';
  const ctx: ReplyContext = { msg, customer, conversationId: conversation.id, channel, language };

  // Plain text, menu taps and — when the assistant is on — a PICTURE enter the automatic conversation. A picture is answered only through
  // the AI path after the vision model has looked at the actual image (never through the menu, and never inside a guided request, where
  // a typed answer is expected). A voice note, audio, video, document, sticker, location, reaction... is recorded for the team and NEVER
  // answered: no apology, no menu, no AI. Staff can still reply by hand.
  const picture = msg.type === 'image' && msg.media?.kind === 'image' && settings.autoRepliesEnabled && settings.aiRepliesEnabled && !inGuidedFlow(customer.menu_state)
    ? msg.media
    : null;
  if (msg.type !== 'text' && msg.type !== 'interactive' && !picture) {
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

  // Human handoff: a customer held for staff (waiting for a person, being handled by one, or resolved but not yet returned to the AI)
  // gets NO automatic reply — no menu, no template, no AI. Enforced here on the server, before anything else can answer.
  const hold = getHold(customer.id);
  const isRestart = msg.type === 'text' && (isRestartCommand(msg.text) || isHardRestart(msg.text));
  if (hold) {
    const wantsMenu = msg.interactiveId === MENU_IDS.MAIN_MENU || (msg.type === 'text' && isMenuKeyword(msg.text));
    if (hold.state !== 'HUMAN_ACTIVE' && (wantsMenu || isRestart)) {
      // The customer leaves a waiting or finished handoff by asking for the menu / starting over. A handoff a person is handling is theirs to end.
      customerLeavesHold(customer.id);
      customer = getCustomerById(customer.id, undefined, null) ?? customer;
      ctx.customer = customer;
      if (!isRestart) {
        setCustomerMenuState(customer.id, MENU_STATES.MAIN_MENU, null);
        await replyTemplate({ ...ctx, customer }, 'main_menu', 'rule', {}, 'Customer returned from human support');
        return;
      }
    } else {
      // Asking again for a person only updates the existing handoff (and reopens a resolved one); it never creates another or answers.
      if (msg.type === 'text' && detectHumanHandoffIntent(msg.text).requested) {
        requestHandoff({ customerId: customer.id, conversationId: conversation.id, source: 'customer' });
      }
      suppressedByHandoff(ctx, hold);
      return;
    }
  }

  // Restart: forget language, menu position, and booking state; the next turn starts from the welcome.
  if (isRestart) {
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

  // The customer asks for a person: a persistent handoff is created (once — repeating the request only updates it) and the
  // assistant goes quiet for this customer. Inside a guided request only the exact keywords count (see handoff/intent.ts).
  if (msg.type === 'text') {
    const intent = detectHumanHandoffIntent(msg.text, { inGuidedFlow: inGuidedFlow(customer.menu_state) });
    if (intent.requested) {
      requestHandoff({ customerId: customer.id, conversationId: conversation.id, source: 'customer', reason: 'Customer requested a human' });
      setCustomerMenuState(customer.id, MENU_STATES.MAIN_MENU, null);
      logger.info({ waId: maskedId, rule: intent.rule }, 'customer asked for a person: handoff requested');
      await replyTemplate(ctx, 'human_support', 'human_handoff');
      await replyOutOfHours(ctx);
      return;
    }
  }

  // A brand-new customer whose very first message is a real question (or a picture) gets an ANSWER (in the language they wrote), not a
  // language prompt. The language stored here only selects the MENU texts; the assistant itself follows the customer's latest message.
  if (!customer.language && settings.aiRepliesEnabled && (picture || (msg.type === 'text' && isSubstantiveFreeText(msg.text)))) {
    const detected = detectLanguageFromScript(msg.text) ?? (picture ? 'en' : undefined);
    if (detected) {
      customer = setCustomerLanguage(customer.id, detected);
      customer = setCustomerMenuState(customer.id, MENU_STATES.MAIN_MENU, null);
      ctx.customer = customer;
      ctx.language = detected;
    }
  }

  if (settings.ruleRepliesEnabled && !picture) {
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

  // A picture is looked at ONCE, by the vision model, before the assistant answers; its report is stored beside the customer's message
  // (hidden from the inbox, visible to the model now and in later turns), so a follow-up question about "this car" is answered from the
  // same photo and the photo is never analysed twice. A failed analysis is stored as an honest note, never as a guess.
  const startedAt = Date.now();
  let analysis: ImageAnalysis | null = null;
  if (picture) {
    analysis = await analyzeImage({ mimeType: picture.mimeType, fileLength: picture.fileLength, download: picture.download, caption: msg.text, deadline: startedAt + env.AI_LOOP_TIMEOUT_MS });
    appendMessage(conversation.id, { role: 'tool', toolName: IMAGE_ANALYSIS_TOOL, content: imageContextLine(analysis), whatsappMessageId: msg.messageId, metadata: { ok: analysis.ok, reason: analysis.ok ? undefined : analysis.reason, model: analysis.ok ? analysis.model : undefined, confidence: analysis.ok ? analysis.confidence : undefined, durationMs: analysis.durationMs } });
  }

  // The model's memory of this customer in this business: this conversation only, the latest N messages, and nothing older than
  // CONVERSATION_MEMORY_HOURS (docs/AI_ASSISTANT.md). The stored conversation is untouched.
  const history = getRecentMessages(conversation.id, getBusinessSettings().conversationHistoryLimit, undefined, env.CONVERSATION_MEMORY_HOURS);
  const systemPrompt = buildSystemPrompt(deps.knowledge, customer.language ?? undefined, new Date(), { customerId: customer.id, latestText: msg.text });

  let finalText = '';
  let kind: 'ai' | 'error' = 'ai';
  let failureDetail = 'AI failed; fallback sent';
  let verdict: 'send' | 'ai_handoff' | 'dropped' = 'send';
  let heldBy: Handoff | null = null;
  const visionNote = analysis ? (analysis.ok ? `picture analysed in ${(analysis.durationMs / 1000).toFixed(1)} s (${analysis.model}, confidence ${analysis.confidence})` : `picture not analysed (${analysis.reason})`) : null;
  try {
    const loopResult = await runAgentLoop({ systemPrompt, history, conversationId: conversation.id });
    logger.info({ waId: maskedId, account: currentAccountId(), totalMs: Date.now() - startedAt, visionMs: analysis?.durationMs ?? 0, picture: Boolean(picture), rounds: loopResult.generatedMessages.filter((g) => g.content.startsWith('[requested tools:')).length + 1 }, 'AI reply ready');
    finalText = loopResult.finalText;
    // The model took a while: ownership may have changed meanwhile. Decide from the database NOW, before anything is stored or sent.
    heldBy = getHold(customer.id);
    if (heldBy && heldBy.source === 'ai' && heldBy.state === 'HUMAN_REQUESTED') {
      // The assistant itself asked for a person (its handoff tool): keep the tool trail, drop its text, send the hand-over acknowledgement.
      for (const generated of loopResult.generatedMessages.filter((g) => g.role === 'tool' || g.content.startsWith('[requested tools:'))) {
        appendMessage(conversation.id, { role: generated.role, content: generated.content, toolCallId: generated.toolCallId, toolName: generated.toolName, direction: generated.role === 'assistant' ? MESSAGE_DIRECTION.OUTBOUND : undefined });
      }
      verdict = 'ai_handoff';
    } else if (heldBy) {
      // A staff member took over while the answer was being written: it is discarded, never stored as sent, never sent.
      verdict = 'dropped';
    } else {
      for (const generated of loopResult.generatedMessages) {
        appendMessage(conversation.id, {
          role: generated.role,
          content: generated.content,
          toolCallId: generated.toolCallId,
          toolName: generated.toolName,
          direction: generated.role === 'assistant' ? MESSAGE_DIRECTION.OUTBOUND : undefined,
        });
      }
    }
  } catch (error) {
    const credentialProblem = error instanceof AiCredentialError ? error : null;
    const responseProblem = error instanceof AiResponseError ? error : null;
    // Safe diagnostics only: category, HTTP status, model and the provider's short reason — never the key, the prompt or the customer's text.
    logger.error(
      {
        waId: maskedId, errorName: (error as Error)?.name, errorMessage: String((error as Error)?.message ?? error).slice(0, 200), credentialReason: credentialProblem?.reason,
        aiReason: responseProblem?.reason, aiHttpStatus: responseProblem?.httpStatus, aiModel: responseProblem?.model, aiProviderMessage: responseProblem?.providerMessage,
      },
      'agent loop failed for inbound message',
    );
    if (responseProblem) failureDetail = `AI failed; fallback sent (${responseProblem.describe()})`;
    if (credentialProblem) {
      // The provider key is unusable: every message would fail the same way. Tell the customer once in a while, not on every message.
      if (!allowCredentialFallback(currentAccountId(), msg.waId)) {
        recordReplyActivity({ customerId: customer.id, waId: msg.waId, channel, kind: 'suppressed', detail: `AI credential problem (${credentialProblem.reason}) — apology already sent recently` });
        return;
      }
      failureDetail = `AI credential problem (${credentialProblem.reason}): fallback sent. Enter a valid OpenRouter key in the dashboard (Providers).`;
    }
    heldBy = getHold(customer.id); // staff may have taken over while the model call was failing
    if (heldBy) {
      verdict = 'dropped';
    } else {
      kind = 'error';
      finalText = resolveTemplate('fallback_error', language);
      appendMessage(conversation.id, { role: 'assistant', content: finalText, direction: MESSAGE_DIRECTION.OUTBOUND });
    }
  }

  if (verdict === 'ai_handoff') {
    setCustomerMenuState(customer.id, MENU_STATES.MAIN_MENU, null);
    await replyTemplate(ctx, 'human_support', 'human_handoff', {}, 'The assistant handed the conversation to staff');
    await replyOutOfHours(ctx);
    return;
  }
  if (verdict === 'dropped') {
    suppressedByHandoff(ctx, heldBy);
    return;
  }

  try {
    await sendTextMessage(msg.waId, finalText);
    recordReplyActivity({ customerId: customer.id, waId: msg.waId, channel, kind, detail: kind === 'error' ? [failureDetail, visionNote].filter(Boolean).join(' · ') : [`answered in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`, visionNote].filter(Boolean).join(' · ') });
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
  if (route.kind === 'human_handoff') {
    requestHandoff({ customerId: customer.id, conversationId: ctx.conversationId, source: 'menu', reason: 'Customer chose "Talk to staff"' });
    customer = getCustomerById(customer.id, undefined, null) ?? customer;
  }

  if (route.cart) {
    await applyCart(ctx, customer, route.cart.input);
    return;
  }

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

/** One Inquiry Cart step: the cart changes first, then the customer's menu state, then the replies (one WhatsApp message each). */
async function applyCart(ctx: ReplyContext, customer: Customer, input: string | null): Promise<void> {
  const outcome = runCart(customer, ctx.msg.waId, input);
  const updated = setCustomerMenuState(customer.id, outcome.state, outcome.flowData);
  const language: CustomerLanguage = updated.language ?? 'en';
  const nextCtx: ReplyContext = { ...ctx, customer: updated, language };
  if (outcome.request) {
    logger.info({ waId: maskWaId(ctx.msg.waId), reference: outcome.request.reference }, 'inquiry cart submitted as a quotation request');
    try {
      notifyBusinessNewRequest(outcome.request);
    } catch (error) {
      logger.error({ error, reference: outcome.request.reference }, 'could not queue the staff alert for a new request');
    }
  }
  for (const r of outcome.replies) await replyTemplate(nextCtx, r.key, 'rule', r.vars ?? {});
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
  if (rule.placeholder === 'projects') {
    // the published projects of THIS business; with none, the "no project published" page (never an invented list)
    const projects = vars.projects ?? renderPublishedProjects(language);
    if (!projects.trim()) return rule.fallback;
    vars.projects = projects;
    return key;
  }
  const offers = vars.offers ?? renderCustomerOffers(language);
  if (!offers.trim()) return rule.fallback;
  vars.offers = offers;
  return key;
}
