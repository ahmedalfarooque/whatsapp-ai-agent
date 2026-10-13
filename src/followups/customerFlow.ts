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
import { appointmentTypeLabel, listAppointmentTypes, type AppointmentType } from './appointmentTypes';
import { activeFollowupsForCustomer, type ContactMethod, type FollowupRequest } from './followupRepo';
import { cancelFollowup, createFollowup, describeWhen, directCallAvailable, FollowupError, methodLabel } from './followupService';
import { parseRequestedTime } from './timeParsing';

/**
 * The customer side of follow-up requests on WhatsApp: the numbered menu offered after hours (and on request), the short guided
 * flow (contact method → appointment type → time) and "cancel an existing request". Like the main menu router it decides WHICH
 * templates to send and how the state changes; the texts are the editable templates. Unlike it, it persists the request itself
 * (createFollowup) — and a menu choice is never confirmed to the customer before the row exists.
 *
 * States (customers.menu_state): FOLLOWUP_MENU, FOLLOWUP_METHOD, FOLLOWUP_TYPE, FOLLOWUP_TIME, FOLLOWUP_CANCEL. Answers travel in flow_data.
 */

export const FOLLOWUP_STATES = {
  MENU: 'FOLLOWUP_MENU',
  METHOD: 'FOLLOWUP_METHOD',
  TYPE: 'FOLLOWUP_TYPE',
  TIME: 'FOLLOWUP_TIME',
  CANCEL: 'FOLLOWUP_CANCEL',
} as const;

export const isFollowupState = (state: string | null | undefined): boolean => Boolean(state && state.startsWith('FOLLOWUP_'));

const CANCEL_WORDS = /^(cancel|cancel request|cancel my request|إلغاء|الغاء|إلغاء الطلب|الغاء الطلب)$/i;

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
}

export interface FollowupRouteInput {
  text: string | undefined;
  customer: Customer;
  conversationId: number;
  language: CustomerLanguage;
  settings?: BusinessSettings;
  now?: Date;
}

function renderTypeList(types: AppointmentType[], language: CustomerLanguage): string {
  return types.map((t, i) => `${keycap(i + 1)} ${appointmentTypeLabel(t, language)}`).join('\n');
}

function renderRequestList(rows: FollowupRequest[], language: CustomerLanguage, now: Date): string {
  return rows.map((r, i) => `${keycap(i + 1)} ${r.reference} · ${methodLabel(r.contact_method, language)}${r.appointment_type_label ? ` · ${r.appointment_type_label}` : ''} · ${describeWhen(r, language, now)}`).join('\n');
}

function nextOpenText(settings: BusinessSettings, language: CustomerLanguage, now: Date): string {
  const next = nextOpening(settings, now);
  return next ? describeMoment(settings, next, language, now) : language === 'ar' ? 'قريباً' : 'soon';
}

/** The follow-up menu bubble (closed or open variant) with the variables it needs. */
export function followupMenuSend(settings: BusinessSettings, language: CustomerLanguage, now: Date = new Date()): FollowupSend {
  const direct = directCallAvailable(settings, now);
  return direct.available
    ? { key: 'followup_menu_open', vars: { phone: direct.phone ?? '' } }
    : { key: 'followup_menu', vars: {} };
}

/** The after-hours notice bubble ({hours}, {next_open}). */
export function afterHoursNoticeSend(settings: BusinessSettings, language: CustomerLanguage, now: Date = new Date()): FollowupSend {
  return { key: 'after_hours_notice', vars: { hours: formatBusinessHours(settings, language), next_open: nextOpenText(settings, language, now) } };
}

const back = (): FollowupRouteResult => ({ send: [{ key: 'main_menu' }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: 'back to the main menu' });

function startFlow(method: ContactMethod | null, intent: 'asap' | 'time', language: CustomerLanguage, now: Date): FollowupRouteResult {
  const data: Record<string, string> = { intent, ...(method ? { method } : {}) };
  if (!method) return { send: [{ key: 'followup_method_prompt' }], state: FOLLOWUP_STATES.METHOD, flowData: data, detail: 'asked for the contact method' };
  const types = listAppointmentTypes(undefined, { enabledOnly: true });
  return { send: [{ key: 'followup_type_prompt', vars: { types: renderTypeList(types, language) } }], state: FOLLOWUP_STATES.TYPE, flowData: data, detail: `asked for the appointment type (${method})` };
}

/** Persists the request and chooses the confirmation; a save failure is told honestly and the customer is returned to the menu. */
function persist(input: FollowupRouteInput, data: Record<string, string>, requestedAt: Date | null, settings: BusinessSettings, now: Date): FollowupRouteResult {
  const method: ContactMethod = data.method === 'whatsapp' ? 'whatsapp' : 'call';
  try {
    const created = createFollowup({ customerId: input.customer.id, conversationId: input.conversationId, contactMethod: method, appointmentTypeKey: data.type ?? null, requestedAt, asap: !requestedAt, source: 'customer', now });
    const type = created.appointment_type_key ? listAppointmentTypes(undefined, {}).find((t) => t.key === created.appointment_type_key) : undefined;
    const vars: TemplateVars = {
      reference: created.reference, type: type ? appointmentTypeLabel(type, input.language) : (input.language === 'ar' ? 'غير محدد' : 'not specified'), method: methodLabel(method, input.language),
      when: describeWhen(created, input.language, now), window: input.language === 'ar' ? `${settings.callbackWindowMinutes} دقيقة` : `${settings.callbackWindowMinutes} minutes`, next_open: nextOpenText(settings, input.language, now),
    };
    const send: FollowupSend[] = [];
    if (created.status === 'scheduled') send.push({ key: 'followup_confirm_scheduled', vars });
    else if (created.status === 'eligible') send.push({ key: 'followup_confirm_asap_open', vars });
    else send.push({ key: 'followup_confirm_asap_closed', vars });
    if (method === 'whatsapp') send.push({ key: 'followup_confirm_whatsapp', vars });
    return { send, state: MENU_STATES.MAIN_MENU, flowData: null, detail: `follow-up ${created.reference} saved (${created.status})`, created };
  } catch (error) {
    if (error instanceof FollowupError && error.code === 'outside_hours' && requestedAt) {
      return { send: [{ key: 'followup_time_closed', vars: { when: describeMoment(settings, DateTime.fromJSDate(requestedAt, { zone: settings.businessTimezone }), input.language, now), next_open: nextOpenText(settings, input.language, now), hours: formatBusinessHours(settings, input.language) } }], state: FOLLOWUP_STATES.TIME, flowData: data, detail: 'requested time is outside opening hours' };
    }
    if (error instanceof FollowupError && (error.code === 'in_past' || error.code === 'too_far' || error.code === 'invalid_time')) {
      return { send: [{ key: 'followup_time_invalid' }], state: FOLLOWUP_STATES.TIME, flowData: data, detail: `requested time rejected (${error.code})` };
    }
    logger.error({ customerId: input.customer.id, error: String((error as Error).message).slice(0, 200) }, '[FOLLOWUP] request could not be saved');
    return { send: [{ key: 'followup_save_failed', vars: { phone: settings.contactPhone ?? '' } }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: 'follow-up request could NOT be saved; the customer was told' };
  }
}

/**
 * Routes one message while the customer is in a follow-up state, or when they ask to cancel a request. Returns null when the message is
 * not for this flow (free text in the menu goes to the assistant; keywords go to the main router).
 */
export function routeFollowup(input: FollowupRouteInput): FollowupRouteResult | null {
  const now = input.now ?? new Date();
  const settings = input.settings ?? getBusinessSettings();
  const raw = normalizeNumerals((input.text ?? '').trim());
  const state = input.customer.menu_state ?? null;
  const language = input.language;
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/[.!؟?]+$/, '');

  // "cancel" from anywhere outside a guided flow: show the customer's own open requests.
  if (!isFollowupState(state) && CANCEL_WORDS.test(lower)) {
    const open = activeFollowupsForCustomer(input.customer.id);
    if (open.length === 0) return { send: [{ key: 'followup_cancel_none' }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: 'no open follow-up to cancel' };
    return { send: [{ key: 'followup_cancel_list', vars: { requests: renderRequestList(open, language, now) } }], state: FOLLOWUP_STATES.CANCEL, flowData: { ids: open.map((r) => r.id).join(',') }, detail: 'listed open follow-ups for cancellation' };
  }
  if (!isFollowupState(state)) return null;
  if (isMenuKeyword(raw)) return back();
  const digit = /^\d{1,2}$/.test(raw) ? Number(raw) : null;
  const data = getCustomerFlowData(input.customer);

  if (state === FOLLOWUP_STATES.MENU) {
    if (digit === null) return null; // free text: the assistant answers; the menu context stays available
    if (digit === 0) return back();
    if (digit === 1) return startFlow('call', 'asap', language, now);
    if (digit === 2) return startFlow('whatsapp', 'asap', language, now);
    if (digit === 3) return startFlow(null, 'asap', language, now);
    if (digit === 4) return startFlow(null, 'time', language, now);
    if (digit === 5) return { send: [{ key: 'location_hours' }, { key: 'prices_offers_list' }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: 'self-service: location, hours and offers' };
    if (digit === 6) {
      const open = activeFollowupsForCustomer(input.customer.id);
      if (open.length === 0) return { send: [{ key: 'followup_cancel_none' }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: 'no open follow-up to cancel' };
      return { send: [{ key: 'followup_cancel_list', vars: { requests: renderRequestList(open, language, now) } }], state: FOLLOWUP_STATES.CANCEL, flowData: { ids: open.map((r) => r.id).join(',') }, detail: 'listed open follow-ups for cancellation' };
    }
    if (digit === 7) {
      const direct = directCallAvailable(settings, now);
      if (direct.available) return { send: [{ key: 'followup_direct_call', vars: { phone: direct.phone ?? '', when: direct.until ? describeMoment(settings, direct.until, language, now) : '' } }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: 'direct call offered (business open)' };
    }
    return { send: [{ key: 'followup_invalid_option' }, followupMenuSend(settings, language, now)], state: FOLLOWUP_STATES.MENU, flowData: null, detail: 'invalid follow-up option' };
  }

  if (state === FOLLOWUP_STATES.METHOD) {
    if (digit === 0) return { send: [followupMenuSend(settings, language, now)], state: FOLLOWUP_STATES.MENU, flowData: null, detail: 'back to the follow-up menu' };
    if (digit === 1 || digit === 2) return startFlow(digit === 1 ? 'call' : 'whatsapp', data.intent === 'time' ? 'time' : 'asap', language, now);
    return { send: [{ key: 'followup_invalid_option' }, { key: 'followup_method_prompt' }], state, flowData: data, detail: 'invalid contact method' };
  }

  if (state === FOLLOWUP_STATES.TYPE) {
    const types = listAppointmentTypes(undefined, { enabledOnly: true });
    if (digit === 0) return { send: [followupMenuSend(settings, language, now)], state: FOLLOWUP_STATES.MENU, flowData: null, detail: 'back to the follow-up menu' };
    const chosen = digit !== null ? types[digit - 1] : undefined;
    if (!chosen) return { send: [{ key: 'followup_invalid_option' }, { key: 'followup_type_prompt', vars: { types: renderTypeList(types, language) } }], state, flowData: data, detail: 'invalid appointment type' };
    const next: Record<string, string> = { ...data, type: chosen.key };
    if (next.intent === 'time') return { send: [{ key: 'followup_time_prompt', vars: { hours: formatBusinessHours(settings, language) } }], state: FOLLOWUP_STATES.TIME, flowData: next, detail: `type ${chosen.key}; asked for the time` };
    return persist(input, next, null, settings, now);
  }

  if (state === FOLLOWUP_STATES.TIME) {
    if (digit === 0) return { send: [followupMenuSend(settings, language, now)], state: FOLLOWUP_STATES.MENU, flowData: null, detail: 'back to the follow-up menu' };
    const parsed = parseRequestedTime(raw, { zone: settings.businessTimezone, now });
    if (!parsed) return { send: [{ key: 'followup_time_invalid' }], state, flowData: data, detail: 'time not understood' };
    const at = parsed.at.toJSDate();
    if (isOpenAt(settings, at) === false) {
      return { send: [{ key: 'followup_time_closed', vars: { when: describeMoment(settings, parsed.at, language, now), next_open: nextOpenText(settings, language, now), hours: formatBusinessHours(settings, language) } }], state, flowData: data, detail: 'requested time is outside opening hours' };
    }
    return persist(input, data, at, settings, now);
  }

  if (state === FOLLOWUP_STATES.CANCEL) {
    if (digit === 0) return back();
    const ids = (data.ids ?? '').split(',').map(Number).filter(Number.isInteger);
    const id = digit !== null ? ids[digit - 1] : undefined;
    if (!id) {
      const open = activeFollowupsForCustomer(input.customer.id);
      return { send: [{ key: 'followup_invalid_option' }, { key: 'followup_cancel_list', vars: { requests: renderRequestList(open, language, now) } }], state, flowData: data, detail: 'invalid cancel choice' };
    }
    try {
      const cancelled = cancelFollowup(id, { type: 'customer' }, 'cancelled by the customer on WhatsApp');
      return { send: [{ key: 'followup_cancelled', vars: { reference: cancelled.reference } }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: `follow-up ${cancelled.reference} cancelled by the customer`, cancelled };
    } catch (error) {
      logger.warn({ id, error: String((error as Error).message) }, '[FOLLOWUP] customer cancellation failed');
      return { send: [{ key: 'followup_save_failed', vars: { phone: settings.contactPhone ?? '' } }], state: MENU_STATES.MAIN_MENU, flowData: null, detail: 'cancellation failed; the customer was told' };
    }
  }
  return null;
}
