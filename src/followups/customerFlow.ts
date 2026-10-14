import { DateTime } from 'luxon';
import type { Customer, CustomerLanguage } from '../memory/customerRepo';
import { getCustomerFlowData } from '../memory/customerRepo';
import type { TemplateVars } from '../templates/templateRepo';
import { normalizeNumerals } from '../whatsapp/jid';
import { getBusinessSettings, formatBusinessHours, type BusinessSettings } from '../config/businessSettings';
import { describeMoment, isOpenAt, nextOpening } from '../setup/hours';
import { keycap } from '../automation/menuConfig';
import { isMenuKeyword } from '../automation/menu';
import { MENU_STATES } from '../automation/menuStatic';
import { logger } from '../logger';
import { activeFollowupsForCustomer, lastContactMethod, type ContactMethod, type FollowupRequest } from './followupRepo';
import { cancelFollowup, createFollowup, describeWhen, directCallAvailable, FollowupError, methodLabel, rescheduleFollowup } from './followupService';
import { parseRequestedTime } from './timeParsing';

/**
 * The customer side of follow-up requests on WhatsApp — deliberately SHORT. The follow-up menu has at most three choices:
 *   1 Request a callback   2 Call us now (the business's own number)   3 Manage my request (only when one is open)
 * "Request a callback" asks one question (as soon as possible, or a date and time); the contact method defaults to the customer's last
 * choice (phone call unless they asked for a WhatsApp message before) and the appointment type is not asked. Managing a request offers
 * cancel or reschedule. Like the main menu router it decides WHICH templates to send and how the state changes; the texts are the
 * editable templates. Unlike it, it persists the request itself (createFollowup) — a choice is never confirmed before the row exists.
 *
 * States (customers.menu_state): FOLLOWUP_MENU, FOLLOWUP_CALLBACK, FOLLOWUP_TIME, FOLLOWUP_CANCEL (the list of open requests),
 * FOLLOWUP_MANAGE (cancel / reschedule one), FOLLOWUP_RESCHEDULE (the new time). FOLLOWUP_METHOD and FOLLOWUP_TYPE belong to the
 * older, longer flow: a customer who is mid-way through one of them after an upgrade is simply returned to the menu.
 */

export const FOLLOWUP_STATES = {
  MENU: 'FOLLOWUP_MENU',
  CALLBACK: 'FOLLOWUP_CALLBACK',
  TIME: 'FOLLOWUP_TIME',
  CANCEL: 'FOLLOWUP_CANCEL',
  MANAGE: 'FOLLOWUP_MANAGE',
  RESCHEDULE: 'FOLLOWUP_RESCHEDULE',
} as const;

export const isFollowupState = (state: string | null | undefined): boolean => Boolean(state && state.startsWith('FOLLOWUP_'));

const CANCEL_WORDS = /^(cancel|cancel request|cancel my request|إلغاء|الغاء|إلغاء الطلب|الغاء الطلب)$/i;
const RESCHEDULE_WORDS = /^(reschedule|change time|change my callback|تغيير الموعد|تعديل الموعد|تغيير الوقت)$/i;

export interface FollowupSend {
  key: string;
  vars?: TemplateVars;
}

export interface FollowupRouteResult {
  send: FollowupSend[];
  /** New menu state (null = main menu, no follow-up context). */
  state: string | null;
  flowData: Record<string, string> | null;
  /** For the activity record. */
  detail: string;
  created?: FollowupRequest;
  cancelled?: FollowupRequest;
  rescheduled?: FollowupRequest;
}

export interface FollowupRouteInput {
  text: string | undefined;
  customer: Customer;
  conversationId: number;
  language: CustomerLanguage;
  settings?: BusinessSettings;
  now?: Date;
}

function renderRequestList(rows: FollowupRequest[], language: CustomerLanguage, now: Date): string {
  return rows.map((r, i) => `${keycap(i + 1)} ${r.reference} · ${methodLabel(r.contact_method, language)} · ${describeWhen(r, language, now)}`).join('\n');
}

function nextOpenText(settings: BusinessSettings, language: CustomerLanguage, now: Date): string {
  const next = nextOpening(settings, now);
  return next ? describeMoment(settings, next, language, now) : language === 'ar' ? 'قريباً' : 'soon';
}

type MenuChoice = 'callback' | 'call' | 'manage';

/** The choices on offer RIGHT NOW, in the order they are numbered: the same list builds the text and reads the answer. */
export function followupMenuChoices(settings: BusinessSettings, customerId: number | null): MenuChoice[] {
  const choices: MenuChoice[] = ['callback'];
  if (settings.directCallEnabled && settings.contactPhone) choices.push('call');
  if (customerId !== null && activeFollowupsForCustomer(customerId).length > 0) choices.push('manage');
  return choices;
}

/** "1️⃣ Request a callback / 2️⃣ Call us now: +966… / 3️⃣ Manage my request" in the customer's language. */
export function followupOptionsText(settings: BusinessSettings, language: CustomerLanguage, customerId: number | null): string {
  const label: Record<MenuChoice, { en: string; ar: string }> = {
    callback: { en: 'Request a callback', ar: 'طلب اتصال' },
    call: { en: `Call us now: ${settings.contactPhone ?? ''}`, ar: `اتصل بنا الآن: ${settings.contactPhone ?? ''}` },
    manage: { en: 'Manage my callback request', ar: 'إدارة طلب الاتصال' },
  };
  return followupMenuChoices(settings, customerId).map((c, i) => `${keycap(i + 1)} ${label[c][language]}`).join('\n');
}

/** The follow-up menu bubble. */
export function followupMenuSend(settings: BusinessSettings, language: CustomerLanguage, _now: Date = new Date(), customerId: number | null = null): FollowupSend {
  return { key: 'followup_menu', vars: { options: followupOptionsText(settings, language, customerId) } };
}

/** The after-hours notice bubble ({hours}, {next_open}). */
export function afterHoursNoticeSend(settings: BusinessSettings, language: CustomerLanguage, now: Date = new Date()): FollowupSend {
  return { key: 'after_hours_notice', vars: { hours: formatBusinessHours(settings, language), next_open: nextOpenText(settings, language, now) } };
}

const back = (): FollowupRouteResult => ({ send: [{ key: 'main_menu' }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: 'back to the main menu' });
const toMenu = (settings: BusinessSettings, language: CustomerLanguage, now: Date, customerId: number | null, detail = 'back to the follow-up menu'): FollowupRouteResult => ({ send: [followupMenuSend(settings, language, now, customerId)], state: FOLLOWUP_STATES.MENU, flowData: null, detail });

/** How this customer wants to be reached: their last request's method (a WhatsApp message if they asked for one before), else a phone call. */
function preferredMethod(customerId: number): ContactMethod {
  return lastContactMethod(customerId) ?? 'call';
}

/** Persists the request and chooses the confirmation; a save failure is told honestly and the customer is returned to the menu. */
function persist(input: FollowupRouteInput, requestedAt: Date | null, settings: BusinessSettings, now: Date, data: Record<string, string>): FollowupRouteResult {
  const method: ContactMethod = data.method === 'whatsapp' ? 'whatsapp' : data.method === 'call' ? 'call' : preferredMethod(input.customer.id);
  try {
    const created = createFollowup({ customerId: input.customer.id, conversationId: input.conversationId, contactMethod: method, appointmentTypeKey: null, requestedAt, asap: !requestedAt, source: 'customer', now });
    const vars: TemplateVars = {
      reference: created.reference, type: input.language === 'ar' ? 'غير محدد' : 'not specified', method: methodLabel(method, input.language),
      when: describeWhen(created, input.language, now), window: input.language === 'ar' ? `${settings.callbackWindowMinutes} دقيقة` : `${settings.callbackWindowMinutes} minutes`, next_open: nextOpenText(settings, input.language, now),
    };
    const send: FollowupSend[] = [];
    if (created.status === 'scheduled') send.push({ key: 'followup_confirm_scheduled', vars });
    else if (created.status === 'eligible') send.push({ key: 'followup_confirm_asap_open', vars });
    else send.push({ key: 'followup_confirm_asap_closed', vars });
    if (method === 'whatsapp') send.push({ key: 'followup_confirm_whatsapp', vars });
    return { send, state: MENU_STATES.MAIN_MENU, flowData: null, detail: `follow-up ${created.reference} saved (${created.status})`, created };
  } catch (error) {
    return timeProblem(error, input, data, settings, now, 'follow-up request could NOT be saved; the customer was told');
  }
}

/** The shared answer to a time that was refused (closed, in the past, unreadable) or an unexpected failure. */
function timeProblem(error: unknown, input: FollowupRouteInput, data: Record<string, string>, settings: BusinessSettings, now: Date, failDetail: string): FollowupRouteResult {
  const state = data.reschedule ? FOLLOWUP_STATES.RESCHEDULE : FOLLOWUP_STATES.TIME;
  if (error instanceof FollowupError && error.code === 'outside_hours') {
    const when = data.requestedAt ? DateTime.fromISO(data.requestedAt, { zone: settings.businessTimezone }) : null;
    return { send: [{ key: 'followup_time_closed', vars: { when: when ? describeMoment(settings, when, input.language, now) : '', next_open: nextOpenText(settings, input.language, now), hours: formatBusinessHours(settings, input.language) } }], state, flowData: data, detail: 'requested time is outside opening hours' };
  }
  if (error instanceof FollowupError && (error.code === 'in_past' || error.code === 'too_far' || error.code === 'invalid_time')) {
    return { send: [{ key: 'followup_time_invalid' }], state, flowData: data, detail: `requested time rejected (${error.code})` };
  }
  logger.error({ customerId: input.customer.id, error: String((error as Error).message).slice(0, 200) }, '[FOLLOWUP] request could not be saved');
  return { send: [{ key: 'followup_save_failed', vars: { phone: settings.contactPhone ?? '' } }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: failDetail };
}

function manageList(input: FollowupRouteInput, language: CustomerLanguage, now: Date, detail: string): FollowupRouteResult {
  const open = activeFollowupsForCustomer(input.customer.id);
  if (open.length === 0) return { send: [{ key: 'followup_cancel_none' }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: 'no open follow-up to manage' };
  return { send: [{ key: 'followup_cancel_list', vars: { requests: renderRequestList(open, language, now) } }], state: FOLLOWUP_STATES.CANCEL, flowData: { ids: open.map((r) => r.id).join(',') }, detail };
}

/**
 * Routes one message while the customer is in a follow-up state, or when they ask to cancel / reschedule a request. Returns null when
 * the message is not for this flow (free text in the menu goes to the assistant; keywords go to the main router).
 */
export function routeFollowup(input: FollowupRouteInput): FollowupRouteResult | null {
  const now = input.now ?? new Date();
  const settings = input.settings ?? getBusinessSettings();
  const raw = normalizeNumerals((input.text ?? '').trim());
  const state = input.customer.menu_state ?? null;
  const language = input.language;
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/[.!؟?]+$/, '');

  // "cancel" / "reschedule" from anywhere outside a guided flow: show the customer's own open requests.
  if (!isFollowupState(state) && (CANCEL_WORDS.test(lower) || RESCHEDULE_WORDS.test(lower))) return manageList(input, language, now, 'listed open follow-ups to cancel or reschedule');
  if (!isFollowupState(state)) return null;
  if (isMenuKeyword(raw)) return back();
  const digit = /^\d{1,2}$/.test(raw) ? Number(raw) : null;
  const data = getCustomerFlowData(input.customer);
  const customerId = input.customer.id;

  if (state === FOLLOWUP_STATES.MENU) {
    if (digit === null) return null; // free text: the assistant answers; the menu context stays available
    if (digit === 0) return back();
    const choice = digit >= 1 ? followupMenuChoices(settings, customerId)[digit - 1] : undefined;
    if (choice === 'callback') return { send: [{ key: 'followup_callback_prompt' }], state: FOLLOWUP_STATES.CALLBACK, flowData: null, detail: 'asked when to call back' };
    if (choice === 'call') {
      const direct = directCallAvailable(settings, now);
      const send: FollowupSend = direct.available
        ? { key: 'followup_direct_call', vars: { phone: direct.phone ?? '', when: direct.until ? describeMoment(settings, direct.until, language, now) : '' } }
        : { key: 'followup_call_closed', vars: { phone: settings.contactPhone ?? '', next_open: nextOpenText(settings, language, now) } };
      return { send: [send], state: MENU_STATES.MAIN_MENU, flowData: null, detail: direct.available ? 'direct call offered (business open)' : 'direct call number given (business closed)' };
    }
    if (choice === 'manage') return manageList(input, language, now, 'listed open follow-ups to cancel or reschedule');
    return { send: [{ key: 'followup_invalid_option' }, followupMenuSend(settings, language, now, customerId)], state: FOLLOWUP_STATES.MENU, flowData: null, detail: 'invalid follow-up option' };
  }

  if (state === FOLLOWUP_STATES.CALLBACK) {
    if (digit === 0) return toMenu(settings, language, now, customerId);
    if (digit === 1) return persist(input, null, settings, now, {});
    if (digit === 2) return { send: [{ key: 'followup_time_prompt', vars: { hours: formatBusinessHours(settings, language) } }], state: FOLLOWUP_STATES.TIME, flowData: { intent: 'time' }, detail: 'asked for the date and time' };
    return { send: [{ key: 'followup_invalid_option' }, { key: 'followup_callback_prompt' }], state, flowData: null, detail: 'invalid callback choice' };
  }

  if (state === FOLLOWUP_STATES.TIME) {
    if (digit === 0) return toMenu(settings, language, now, customerId);
    const parsed = parseRequestedTime(raw, { zone: settings.businessTimezone, now });
    if (!parsed) return { send: [{ key: 'followup_time_invalid' }], state, flowData: data, detail: 'time not understood' };
    const at = parsed.at.toJSDate();
    if (isOpenAt(settings, at) === false) return timeProblem(new FollowupError('closed', 400, 'outside_hours'), input, { ...data, requestedAt: parsed.at.toISO() ?? '' }, settings, now, '');
    return persist(input, at, settings, now, data);
  }

  if (state === FOLLOWUP_STATES.CANCEL) {
    if (digit === 0) return back();
    const ids = (data.ids ?? '').split(',').map(Number).filter(Number.isInteger);
    const id = digit !== null ? ids[digit - 1] : undefined;
    const row = id ? activeFollowupsForCustomer(customerId).find((r) => r.id === id) : undefined;
    if (!row) return manageList(input, language, now, 'invalid request choice');
    return { send: [{ key: 'followup_manage_prompt', vars: { request: renderRequestList([row], language, now).replace(/^\S+\s/, '') } }], state: FOLLOWUP_STATES.MANAGE, flowData: { id: String(row.id) }, detail: `chose ${row.reference} to cancel or reschedule` };
  }

  if (state === FOLLOWUP_STATES.MANAGE) {
    const id = Number(data.id);
    const row = Number.isInteger(id) ? activeFollowupsForCustomer(customerId).find((r) => r.id === id) : undefined;
    if (digit === 0 || !row) return manageList(input, language, now, 'back to the request list');
    if (digit === 1) {
      try {
        const cancelled = cancelFollowup(row.id, { type: 'customer' }, 'cancelled by the customer on WhatsApp');
        return { send: [{ key: 'followup_cancelled', vars: { reference: cancelled.reference } }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: `follow-up ${cancelled.reference} cancelled by the customer`, cancelled };
      } catch (error) {
        logger.warn({ id: row.id, error: String((error as Error).message) }, '[FOLLOWUP] customer cancellation failed');
        return { send: [{ key: 'followup_save_failed', vars: { phone: settings.contactPhone ?? '' } }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: 'cancellation failed; the customer was told' };
      }
    }
    if (digit === 2) return { send: [{ key: 'followup_time_prompt', vars: { hours: formatBusinessHours(settings, language) } }], state: FOLLOWUP_STATES.RESCHEDULE, flowData: { id: String(row.id), reschedule: '1' }, detail: `asked for a new time for ${row.reference}` };
    return { send: [{ key: 'followup_invalid_option' }, { key: 'followup_manage_prompt', vars: { request: renderRequestList([row], language, now).replace(/^\S+\s/, '') } }], state, flowData: data, detail: 'invalid manage choice' };
  }

  if (state === FOLLOWUP_STATES.RESCHEDULE) {
    const id = Number(data.id);
    if (digit === 0 || !Number.isInteger(id)) return manageList(input, language, now, 'back to the request list');
    const parsed = parseRequestedTime(raw, { zone: settings.businessTimezone, now });
    if (!parsed) return { send: [{ key: 'followup_time_invalid' }], state, flowData: data, detail: 'time not understood' };
    const at = parsed.at.toJSDate();
    if (isOpenAt(settings, at) === false) return timeProblem(new FollowupError('closed', 400, 'outside_hours'), input, { ...data, requestedAt: parsed.at.toISO() ?? '' }, settings, now, '');
    try {
      const moved = rescheduleFollowup(id, { type: 'customer' }, at, undefined, undefined, now);
      return { send: [{ key: 'followup_rescheduled', vars: { reference: moved.reference, when: describeWhen(moved, language, now) } }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: `follow-up ${moved.reference} rescheduled by the customer`, rescheduled: moved };
    } catch (error) {
      return timeProblem(error, input, data, settings, now, 'follow-up could NOT be rescheduled; the customer was told');
    }
  }

  // an older flow state (contact method / appointment type) left over from before the simplified flow: back to the short menu
  if (state === 'FOLLOWUP_METHOD' || state === 'FOLLOWUP_TYPE') return toMenu(settings, language, now, customerId, 'left an older follow-up state; back to the menu');
  return null;
}
