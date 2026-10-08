import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId, LEGACY_ACCOUNT_ID } from '../accounts/accountContext';
import { FLOWS, MAIN_MENU_OPTIONS, MENU_STATES, SUBMENUS, type FlowSet, type MenuOption, type SubmenuDef } from './menuStatic';
import { accountHasFeature, FEATURES } from '../accounts/accountFeatures';

/**
 * The guided WhatsApp menu of one business.
 *
 * Account 1 (the original Rowad Alfa business) keeps its built-in structure
 * (menuStatic.ts) untouched. Every other business is described by a MenuConfig:
 * an ordered list of items (max 9, numbered 1..9), each either an information
 * page, a sub-menu, or one of the platform actions (location, offers, an
 * appointment request, a quotation request, hand-off to staff). The text of
 * every information page and of the menus themselves lives in the editable
 * reply templates (Manual Reply Editor) — this module only knows structure.
 */

export type MenuItemKind = 'info' | 'submenu' | 'location' | 'offers' | 'appointment' | 'quotation' | 'handoff' | 'catalogues';
export const MENU_ITEM_KINDS: readonly MenuItemKind[] = ['info', 'submenu', 'location', 'offers', 'appointment', 'quotation', 'handoff', 'catalogues'];

export interface MenuItem {
  /** Letters + digits only, e.g. "services", "brands". Becomes part of the template key. */
  id: string;
  kind: MenuItemKind;
  labelEn: string;
  labelAr: string;
  /** Sub-menu entries (one level only; never another sub-menu). */
  children?: MenuItem[];
}

export interface MenuConfig {
  version: 1;
  items: MenuItem[];
}

export type MenuSource = 'default' | 'generated' | 'manual';

export const MENU_ID_RE = /^[a-z][a-z0-9]{0,23}$/;
export const MAX_MENU_ITEMS = 9;

export class MenuValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------- template keys

/** The reply-template key behind an item's page (info / sub-menu list), or null for platform actions. */
export function templateKeyFor(item: MenuItem, parentId?: string): string | null {
  if (item.kind === 'info' || item.kind === 'submenu') return parentId ? `menu_${parentId}_${item.id}` : `menu_${item.id}`;
  if (item.kind === 'location') return 'location_hours';
  if (item.kind === 'offers') return 'prices_offers_list';
  if (item.kind === 'catalogues') return 'catalogues_list';
  return null;
}

/** Every custom (menu_*) template key the config needs, with the item that owns it. */
export function menuTemplateKeys(config: MenuConfig): { key: string; item: MenuItem; parent: MenuItem | null }[] {
  const out: { key: string; item: MenuItem; parent: MenuItem | null }[] = [];
  for (const item of config.items) {
    const key = item.kind === 'info' || item.kind === 'submenu' ? templateKeyFor(item) : null;
    if (key) out.push({ key, item, parent: null });
    for (const child of item.children ?? []) {
      const childKey = child.kind === 'info' ? templateKeyFor(child, item.id) : null;
      if (childKey) out.push({ key: childKey, item: child, parent: item });
    }
  }
  return out;
}

// ---------------------------------------------------------------- validation

function cleanLabel(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new MenuValidationError(`${field} is required for every menu item`);
  const t = value.replace(/\s+/g, ' ').trim();
  if (t.length > 60) throw new MenuValidationError(`${field} is too long (60 characters max): "${t.slice(0, 20)}…"`);
  return t;
}

function cleanItem(raw: unknown, depth: number, seen: Set<string>): MenuItem {
  if (!raw || typeof raw !== 'object') throw new MenuValidationError('Invalid menu item');
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim().toLowerCase() : '';
  if (!MENU_ID_RE.test(id)) throw new MenuValidationError(`Menu item id "${String(r.id)}" must be letters/digits only (start with a letter, max 24)`);
  if (seen.has(id)) throw new MenuValidationError(`Menu item id "${id}" is used twice`);
  seen.add(id);
  const kind = r.kind as MenuItemKind;
  if (!MENU_ITEM_KINDS.includes(kind)) throw new MenuValidationError(`Unknown menu item kind "${String(r.kind)}"`);
  const item: MenuItem = { id, kind, labelEn: cleanLabel(r.labelEn, 'English label'), labelAr: cleanLabel(r.labelAr, 'Arabic label') };
  if (kind === 'submenu') {
    if (depth > 0) throw new MenuValidationError('A sub-menu cannot contain another sub-menu');
    const children = Array.isArray(r.children) ? r.children : [];
    if (children.length < 1) throw new MenuValidationError(`Sub-menu "${id}" needs at least one entry`);
    if (children.length > MAX_MENU_ITEMS) throw new MenuValidationError(`Sub-menu "${id}" can have at most ${MAX_MENU_ITEMS} entries`);
    item.children = children.map((c) => cleanItem(c, depth + 1, seen));
  } else if (r.children !== undefined && Array.isArray(r.children) && r.children.length > 0) {
    throw new MenuValidationError(`Only sub-menus can have entries ("${id}")`);
  }
  return item;
}

/** Throws MenuValidationError (HTTP 400) on anything unusable; returns the cleaned config. */
export function validateMenuConfig(raw: unknown): MenuConfig {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { items?: unknown }).items)) throw new MenuValidationError('The menu must contain a list of items');
  const items = (raw as { items: unknown[] }).items;
  if (items.length < 1) throw new MenuValidationError('The menu needs at least one item');
  if (items.length > MAX_MENU_ITEMS) throw new MenuValidationError(`The main menu can have at most ${MAX_MENU_ITEMS} items`);
  const seen = new Set<string>();
  const cleaned = items.map((i) => cleanItem(i, 0, seen));
  const singletons = new Set<string>();
  for (const item of cleaned) {
    // location/offers/appointment/quotation/handoff may appear once at the top level (they are the platform's own flows).
    if (['location', 'offers', 'appointment', 'quotation', 'handoff', 'catalogues'].includes(item.kind)) {
      if (singletons.has(item.kind)) throw new MenuValidationError(`The menu can only have one "${item.kind}" item`);
      singletons.add(item.kind);
    }
  }
  return { version: 1, items: cleaned };
}

// ---------------------------------------------------------------- defaults

/** The menu every non-original business starts with: neutral, no business facts. */
export const DEFAULT_GENERIC_MENU: MenuConfig = {
  version: 1,
  items: [
    { id: 'about', kind: 'info', labelEn: 'About us', labelAr: 'من نحن' },
    { id: 'offerings', kind: 'info', labelEn: 'Services & products', labelAr: 'خدماتنا ومنتجاتنا' },
    { id: 'offers', kind: 'offers', labelEn: 'Offers', labelAr: 'العروض' },
    { id: 'location', kind: 'location', labelEn: 'Location & opening hours', labelAr: 'الموقع وساعات العمل' },
    { id: 'contact', kind: 'info', labelEn: 'Contact us', labelAr: 'تواصل معنا' },
    { id: 'quote', kind: 'quotation', labelEn: 'Request a quotation', labelAr: 'طلب عرض سعر' },
    { id: 'book', kind: 'appointment', labelEn: 'Book an appointment', labelAr: 'حجز موعد' },
    { id: 'staff', kind: 'handoff', labelEn: 'Talk to our team', labelAr: 'التحدث مع موظف' },
  ],
};

// ---------------------------------------------------------------- storage

interface MenuRow {
  config_json: string;
  source: string;
  updated_at: string;
}

export interface StoredMenu {
  config: MenuConfig;
  source: MenuSource;
  updatedAt: string | null;
}

/** The effective menu of a non-original business: its stored config, else the generic default. */
export function getMenuConfig(accountId: number = currentAccountId(), db: Database.Database = getDb()): StoredMenu {
  let row: MenuRow | undefined;
  try {
    row = db.prepare('SELECT config_json, source, updated_at FROM account_menus WHERE whatsapp_account_id = ?').get(accountId) as MenuRow | undefined;
  } catch {
    row = undefined; // very old test databases
  }
  if (row) {
    try {
      return { config: validateMenuConfig(JSON.parse(row.config_json)), source: row.source === 'generated' ? 'generated' : 'manual', updatedAt: row.updated_at };
    } catch {
      /* a corrupt row must never take the menu down: fall back to the default below */
    }
  }
  return { config: DEFAULT_GENERIC_MENU, source: 'default', updatedAt: null };
}

export function saveMenuConfig(accountId: number, raw: unknown, source: 'generated' | 'manual', db: Database.Database = getDb()): StoredMenu {
  if (accountId === LEGACY_ACCOUNT_ID) throw new MenuValidationError('The original business keeps its built-in menu structure');
  const config = validateMenuConfig(raw);
  // The catalogue entry exists only for a business that has the catalogue library switched on.
  if (config.items.some((i) => i.kind === 'catalogues') && !accountHasFeature(accountId, FEATURES.CATALOGUES, db)) {
    throw new MenuValidationError('The catalogue list is not available for this business');
  }
  db.prepare(
    `INSERT INTO account_menus (whatsapp_account_id, config_json, source, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(whatsapp_account_id) DO UPDATE SET config_json = excluded.config_json, source = excluded.source, updated_at = excluded.updated_at`,
  ).run(accountId, JSON.stringify(config), source);
  return getMenuConfig(accountId, db);
}

export function resetMenuConfig(accountId: number, db: Database.Database = getDb()): StoredMenu {
  db.prepare('DELETE FROM account_menus WHERE whatsapp_account_id = ?').run(accountId);
  return getMenuConfig(accountId, db);
}

// ---------------------------------------------------------------- compilation for the router

export interface MenuTables {
  /** Option number → action for the main menu. */
  main: Record<string, MenuOption>;
  /** Sub-menu state → its list template and option actions. */
  submenus: Record<string, SubmenuDef>;
  flows: FlowSet;
  /** True for the original business's built-in structure. */
  builtIn: boolean;
}

/** Steps collected by the appointment / quotation requests of every non-original business. */
export const GENERIC_FLOWS: FlowSet = {
  appointment: {
    statePrefix: 'APPOINTMENT_STEP_',
    intro: 'appointment_intro',
    confirm: 'appointment_confirm',
    fields: ['name', 'service', 'date', 'time', 'notes'],
    stepTemplate: (step: number) => `appointment_step_${step}`,
  },
  quotation: {
    statePrefix: 'QUOTATION_STEP_',
    intro: 'quotation_intro',
    confirm: 'quotation_confirm',
    fields: ['name', 'service', 'details'],
    stepTemplate: (step: number) => `quotation_step_${step}`,
  },
};

export function submenuStateFor(id: string): string {
  return `SUBMENU_${id.toUpperCase()}`;
}

function optionFor(item: MenuItem, parentId?: string): MenuOption {
  switch (item.kind) {
    case 'info':
      return { template: templateKeyFor(item, parentId) as string };
    case 'submenu':
      return { template: templateKeyFor(item) as string, state: submenuStateFor(item.id) };
    case 'location':
      return { template: 'location_hours' };
    case 'offers':
      return { template: 'prices_offers_list' };
    case 'appointment':
      return { flow: 'appointment' };
    case 'quotation':
      return { flow: 'quotation' };
    case 'handoff':
      return { handoff: true };
    case 'catalogues':
      return { template: 'catalogues_list', state: MENU_STATES.CATALOGUE_SELECT, catalogues: true };
  }
}

export function compileMenu(config: MenuConfig): MenuTables {
  const main: Record<string, MenuOption> = {};
  const submenus: Record<string, SubmenuDef> = {};
  config.items.forEach((item, index) => {
    main[String(index + 1)] = optionFor(item);
    if (item.kind === 'submenu') {
      submenus[submenuStateFor(item.id)] = {
        menuTemplate: templateKeyFor(item) as string,
        options: Object.fromEntries((item.children ?? []).map((child, i) => [String(i + 1), optionFor(child, item.id)])),
      };
    }
  });
  return { main, submenus, flows: GENERIC_FLOWS, builtIn: false };
}

/** What the router uses for this business. The original business always gets its built-in structure. */
export function getMenuTables(accountId: number = currentAccountId(), db: Database.Database = getDb()): MenuTables {
  if (accountId === LEGACY_ACCOUNT_ID) return { main: MAIN_MENU_OPTIONS, submenus: SUBMENUS, flows: FLOWS, builtIn: true };
  return compileMenu(getMenuConfig(accountId, db).config);
}

// ---------------------------------------------------------------- rendering helpers

const KEYCAPS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
export const keycap = (n: number): string => KEYCAPS[n] ?? `${n}.`;

/** The numbered list shown for the main menu (or a sub-menu's entries). */
export function renderMenuList(items: MenuItem[], language: 'ar' | 'en'): string {
  return items.map((item, i) => `${keycap(i + 1)} ${language === 'ar' ? item.labelAr : item.labelEn}`).join('\n');
}

export function renderMainMenuText(config: MenuConfig, language: 'ar' | 'en'): string {
  return language === 'ar'
    ? `أهلاً بك في {business}\n\nكيف يمكننا خدمتك اليوم؟\n\n${renderMenuList(config.items, 'ar')}\n\nأرسل رقم الخيار.`
    : `Welcome to {business}\n\nHow can we help you today?\n\n${renderMenuList(config.items, 'en')}\n\nPlease reply with the option number.`;
}

export function renderSubmenuText(item: MenuItem, language: 'ar' | 'en'): string {
  const title = language === 'ar' ? item.labelAr : item.labelEn;
  const footer = language === 'ar' ? `\n\n${keycap(0)} القائمة الرئيسية` : `\n\n${keycap(0)} Main Menu`;
  return `${title}\n\n${renderMenuList(item.children ?? [], language)}${footer}`;
}
