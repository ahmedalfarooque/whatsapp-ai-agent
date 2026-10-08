import type { Customer, CustomerLanguage } from '../memory/customerRepo';
import { getCustomerFlowData } from '../memory/customerRepo';
import type { TemplateVars } from '../templates/templateRepo';
import { normalizeNumerals } from '../whatsapp/jid';
import { MENU_STATES, type FlowSet, type MenuOption } from './menuStatic';
import { getMenuTables } from './menuConfig';
import { currentAccountId } from '../accounts/accountContext';
import { accountHasFeature, FEATURES } from '../accounts/accountFeatures';
import { isCatalogueRequest } from '../catalogues/catalogueIntent';
import { customerCatalogues } from '../catalogues/catalogueRepo';
import {
  MENU_IDS,
  detectLanguageFromText,
  isChangeLanguageKeyword,
  isGreeting,
  isHumanSupportRequest,
  isMenuKeyword,
} from './menu';

/**
 * Language-first guided menu — a port of the original Antigravity router's
 * state machine. This module decides WHICH templates to send and how the
 * customer's state changes; it never contains customer-facing text (that is
 * in the editable reply templates) and never sends anything itself.
 *
 * Returning null means "not a menu interaction": the pipeline hands the
 * message to the AI agent loop (free text) — that path is preserved.
 */

// The original business's built-in structure lives in menuStatic.ts and is re-exported here for
// existing importers; every other business is compiled from its own MenuConfig (menuConfig.ts).
export { MENU_STATES, MAIN_MENU_OPTIONS, SUBMENUS, FLOWS } from './menuStatic';
export type { MenuOption } from './menuStatic';

/**
 * Data-driven templates that need live records: when the resolver has nothing
 * to fill the placeholder with, the pipeline sends the fallback instead
 * (e.g. no customer-visible offers → the "no current offers" template).
 */
export const DATA_DRIVEN_FALLBACKS: Record<string, { placeholder: 'offers'; fallback: string }> = {
  prices_offers_list: { placeholder: 'offers', fallback: 'prices_offers' },
};

/** Templates the pipeline sends as a second bubble right after the first (mirrored by the dashboard preview). */
export const FOLLOW_UP_TEMPLATES: Record<string, string> = {
  invalid_option: 'main_menu',
  language_changed: 'main_menu',
  restart_confirmation: 'language_selection',
};

/** Legacy Meta Cloud API button/list IDs → the typed command they are equivalent to. */
const LEGACY_INTERACTIVE: Record<string, { text: string; fromMainMenu?: boolean }> = {
  [MENU_IDS.LANG_EN]: { text: 'english' },
  [MENU_IDS.LANG_AR]: { text: 'arabic' },
  [MENU_IDS.CATEGORY_AUDIO]: { text: '1', fromMainMenu: true },
  [MENU_IDS.CATEGORY_ACCESSORIES]: { text: '2', fromMainMenu: true },
  [MENU_IDS.CATEGORY_CARE]: { text: '3', fromMainMenu: true },
  [MENU_IDS.PRICES]: { text: '5', fromMainMenu: true },
  [MENU_IDS.LOCATION]: { text: '6', fromMainMenu: true },
  [MENU_IDS.MAIN_MENU]: { text: '0' },
  [MENU_IDS.CHANGE_LANGUAGE]: { text: 'language' },
};

export interface RouteInput {
  text?: string;
  interactiveId?: string;
  customer: Customer;
}

export interface RouteResult {
  kind: 'rule' | 'human_handoff';
  /** Template keys to send, in order — each becomes one WhatsApp bubble. */
  send: string[];
  vars?: TemplateVars;
  /** New language (null clears it). undefined = unchanged. */
  language?: CustomerLanguage | null;
  /** New menu state (null = none). undefined = unchanged. */
  state?: string | null;
  /** Replaces collected flow answers (null clears). undefined = unchanged. */
  flowData?: Record<string, string> | null;
  /** A completed multi-step flow to persist; the pipeline fills vars.reference from it. */
  request?: { kind: 'appointment' | 'quotation'; payload: Record<string, string> };
  /** A catalogue the customer picked: the pipeline sends its PDF after the template bubbles. */
  catalogueId?: number;
}

const DIGITS = /^\d{1,2}$/;

function withFollowUp(keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    out.push(key);
    const next = FOLLOW_UP_TEMPLATES[key];
    if (next && !keys.includes(next)) out.push(next);
  }
  return out;
}

function chooseLanguage(normalized: string, lower: string): CustomerLanguage | undefined {
  if (normalized === '1') return 'ar';
  if (normalized === '2') return 'en';
  return detectLanguageFromText(lower);
}

/** The catalogue list, generated from the database. With nothing to offer, say so instead of showing an empty list. */
function catalogueList(): RouteResult {
  if (customerCatalogues().length === 0) return { kind: 'rule', send: ['catalogues_none'], state: MENU_STATES.MAIN_MENU, flowData: null };
  return { kind: 'rule', send: ['catalogues_list'], state: MENU_STATES.CATALOGUE_SELECT, flowData: null };
}

function applyOption(option: MenuOption, current: Customer, flows: FlowSet): RouteResult {
  if (option.catalogues) return catalogueList();
  if (option.handoff) {
    return { kind: 'human_handoff', send: ['human_support'], state: MENU_STATES.MAIN_MENU, flowData: null };
  }
  if (option.flow) {
    const flow = flows[option.flow];
    return { kind: 'rule', send: [flow.intro], state: `${flow.statePrefix}1`, flowData: {} };
  }
  return {
    kind: 'rule',
    send: [option.template as string],
    state: option.state ?? current.menu_state ?? MENU_STATES.MAIN_MENU,
  };
}

function invalidChoice(): RouteResult {
  return { kind: 'rule', send: withFollowUp(['invalid_option']), state: MENU_STATES.MAIN_MENU, flowData: null };
}

function continueFlow(flows: FlowSet, kind: 'appointment' | 'quotation', step: number, answer: string, customer: Customer): RouteResult {
  const flow = flows[kind];
  const data = { ...getCustomerFlowData(customer) };
  const field = flow.fields[step - 1];
  if (field) data[field] = answer;
  if (step >= flow.fields.length) {
    return {
      kind: 'rule',
      send: [flow.confirm],
      state: MENU_STATES.MAIN_MENU,
      flowData: null,
      request: { kind, payload: data },
    };
  }
  return { kind: 'rule', send: [flow.stepTemplate(step + 1)], state: `${flow.statePrefix}${step + 1}`, flowData: data };
}

/**
 * Routes one inbound message through the guided menu. Returns null when the
 * message is free text the AI should answer.
 */
export function routeMenu(input: RouteInput): RouteResult | null {
  const { customer } = input;
  const tables = getMenuTables();
  let raw = (input.text ?? '').trim();
  let state = customer.menu_state ?? null;

  if (input.interactiveId) {
    const legacy = LEGACY_INTERACTIVE[input.interactiveId];
    raw = legacy?.text ?? '0';
    if (legacy?.fromMainMenu) state = MENU_STATES.MAIN_MENU;
  }
  if (!raw) return null;

  const normalized = normalizeNumerals(raw);
  const lower = normalized.toLowerCase().replace(/[.!؟?]+$/, '');

  // 1. No language yet: only a language choice moves forward; everything else (re)shows the welcome.
  if (!customer.language) {
    const chosen = chooseLanguage(normalized, lower);
    if (chosen) {
      return { kind: 'rule', send: ['main_menu'], language: chosen, state: MENU_STATES.MAIN_MENU, flowData: null };
    }
    const firstContact = state === null;
    return {
      kind: 'rule',
      send: [firstContact ? 'language_selection' : 'language_reprompt'],
      state: MENU_STATES.AWAITING_LANGUAGE,
    };
  }

  // 2. Language switch in progress.
  if (state === MENU_STATES.AWAITING_LANGUAGE_SWITCH) {
    const chosen = chooseLanguage(normalized, lower);
    if (chosen) {
      return { kind: 'rule', send: withFollowUp(['language_changed']), language: chosen, state: MENU_STATES.MAIN_MENU, flowData: null };
    }
    if (isMenuKeyword(raw)) return { kind: 'rule', send: ['main_menu'], state: MENU_STATES.MAIN_MENU, flowData: null };
    return { kind: 'rule', send: ['language_switch_prompt'] };
  }

  // 3. Universal commands (work in every state once a language is known).
  // "0" on the MAIN menu is its permanent "Change language" option. In a sub-menu or a flow "0" still means "back to the main menu".
  if (normalized === '0' && state === MENU_STATES.MAIN_MENU && !input.interactiveId) {
    return { kind: 'rule', send: ['language_switch_prompt'], state: MENU_STATES.AWAITING_LANGUAGE_SWITCH, flowData: null };
  }
  if (isChangeLanguageKeyword(raw)) {
    return { kind: 'rule', send: ['language_switch_prompt'], state: MENU_STATES.AWAITING_LANGUAGE_SWITCH, flowData: null };
  }
  if (isMenuKeyword(raw) || isGreeting(raw)) {
    return { kind: 'rule', send: ['main_menu'], state: MENU_STATES.MAIN_MENU, flowData: null };
  }
  if (isHumanSupportRequest(raw)) {
    return { kind: 'human_handoff', send: ['human_support'], state: MENU_STATES.MAIN_MENU, flowData: null };
  }
  // Catalogue library (only a business that has it; the original business never enters these branches).
  const hasCatalogues = accountHasFeature(currentAccountId(), FEATURES.CATALOGUES);
  if (hasCatalogues && isCatalogueRequest(raw)) return catalogueList();

  // 4. Multi-step flows consume the whole message as the answer.
  for (const kind of ['appointment', 'quotation'] as const) {
    const prefix = tables.flows[kind].statePrefix;
    if (state?.startsWith(prefix)) {
      const step = Number(state.slice(prefix.length));
      if (Number.isFinite(step) && step >= 1) return continueFlow(tables.flows, kind, step, raw, customer);
    }
  }

  // 4b. Choosing from the catalogue list: the number is the position in the live, enabled list.
  if (hasCatalogues && state === MENU_STATES.CATALOGUE_SELECT) {
    if (!DIGITS.test(normalized)) return null; // free text → AI
    const picked = customerCatalogues()[Number(normalized) - 1];
    if (!picked) return invalidChoice();
    return { kind: 'rule', send: [], catalogueId: picked.id, state: MENU_STATES.CATALOGUE_SELECT, flowData: null };
  }

  // 5. Sub-menus.
  const submenu = state ? tables.submenus[state] : undefined;
  if (submenu) {
    if (!DIGITS.test(normalized)) return null; // free text → AI
    const option = submenu.options[String(Number(normalized))];
    return option ? applyOption(option, customer, tables.flows) : invalidChoice();
  }

  // 6. Main menu (also the default for unknown / stale states).
  if (!DIGITS.test(normalized)) return null; // free text → AI
  const option = tables.main[String(Number(normalized))];
  return option ? applyOption(option, customer, tables.flows) : invalidChoice();
}
