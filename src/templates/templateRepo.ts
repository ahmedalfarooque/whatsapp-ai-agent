import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { getBusinessSettings, formatBusinessHours, formatAddress } from '../config/businessSettings';
import { renderCustomerOffers } from '../offers/offerRepo';
import type { CustomerLanguage } from '../memory/customerRepo';
import { TEMPLATE_DEFAULTS, RETIRED_TEMPLATE_KEYS } from './defaults';

export type TemplateStatus = 'published' | 'draft';

export interface ReplyTemplate {
  key: string;
  category: string;
  titleAr: string;
  titleEn: string;
  defaultAr: string;
  defaultEn: string;
  draftAr: string | null;
  draftEn: string | null;
  liveAr: string;
  liveEn: string;
  status: TemplateStatus;
  hasDraft: boolean;
  isModified: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

interface Row {
  key: string; category: string; title_ar: string; title_en: string; sort_order?: number;
  default_ar: string; default_en: string; draft_ar: string | null; draft_en: string | null;
  live_ar: string; live_en: string; status: string; updated_at: string; updated_by: string | null;
}

function toTemplate(r: Row): ReplyTemplate {
  return {
    key: r.key,
    category: r.category,
    titleAr: r.title_ar,
    titleEn: r.title_en,
    defaultAr: r.default_ar,
    defaultEn: r.default_en,
    draftAr: r.draft_ar,
    draftEn: r.draft_en,
    liveAr: r.live_ar,
    liveEn: r.live_en,
    status: r.status as TemplateStatus,
    hasDraft: r.draft_ar !== null || r.draft_en !== null,
    isModified: r.live_ar !== r.default_ar || r.live_en !== r.default_en,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/**
 * Seeds missing shipped templates and upgrades the shipped DEFAULT text of
 * existing ones. Live text is only moved to the new default when it still
 * equals the old default (i.e. nobody customised it); customised live text
 * and drafts are never touched, so dashboard edits survive upgrades.
 * Retired keys whose text was never customised are removed.
 */
export function ensureTemplateDefaults(db: Database.Database = getDb()): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO reply_templates
       (key, category, title_ar, title_en, default_ar, default_en, live_ar, live_en, status, sort_order, updated_by)
     VALUES (@key, @category, @titleAr, @titleEn, @ar, @en, @ar, @en, 'published', @order, 'system')`,
  );
  const select = db.prepare('SELECT * FROM reply_templates WHERE key = ?');
  const upgrade = db.prepare(
    `UPDATE reply_templates SET category = @category, title_ar = @titleAr, title_en = @titleEn,
       default_ar = @ar, default_en = @en, sort_order = @order,
       live_ar = CASE WHEN live_ar = default_ar THEN @ar ELSE live_ar END,
       live_en = CASE WHEN live_en = default_en THEN @en ELSE live_en END
     WHERE key = @key`,
  );
  const retire = db.prepare(
    `DELETE FROM reply_templates WHERE key = ? AND live_ar = default_ar AND live_en = default_en AND draft_ar IS NULL AND draft_en IS NULL`,
  );
  const run = db.transaction(() => {
    TEMPLATE_DEFAULTS.forEach((t, order) => {
      const existing = select.get(t.key) as Row | undefined;
      if (!existing) {
        insert.run({ ...t, order });
        return;
      }
      const changed =
        existing.default_ar !== t.ar || existing.default_en !== t.en || existing.category !== t.category ||
        existing.title_ar !== t.titleAr || existing.title_en !== t.titleEn;
      if (changed || (existing as Row & { sort_order?: number }).sort_order !== order) upgrade.run({ ...t, order });
    });
    RETIRED_TEMPLATE_KEYS.forEach((key) => retire.run(key));
  });
  run();
}

export function listTemplates(db: Database.Database = getDb()): ReplyTemplate[] {
  ensureTemplateDefaults(db);
  return (db.prepare('SELECT * FROM reply_templates ORDER BY sort_order, key').all() as Row[]).map(toTemplate);
}

export function getTemplate(key: string, db: Database.Database = getDb()): ReplyTemplate | undefined {
  ensureTemplateDefaults(db);
  const row = db.prepare('SELECT * FROM reply_templates WHERE key = ?').get(key) as Row | undefined;
  return row ? toTemplate(row) : undefined;
}

export class TemplateValidationError extends Error {
  status = 400;
}

function assertText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TemplateValidationError(`${label} must be text`);
  const trimmed = value.replace(/\r\n/g, '\n');
  if (!trimmed.trim()) throw new TemplateValidationError(`${label} cannot be empty`);
  if (trimmed.length > 4000) throw new TemplateValidationError(`${label} exceeds 4000 characters`);
  return trimmed;
}

/** Saves an unpublished draft. Live content is untouched, so customers never see it. */
export function saveTemplateDraft(
  key: string,
  input: { ar: unknown; en: unknown },
  updatedBy: string,
  db: Database.Database = getDb(),
): ReplyTemplate {
  if (!getTemplate(key, db)) throw new TemplateValidationError('Template not found');
  const ar = assertText(input.ar, 'Arabic content');
  const en = assertText(input.en, 'English content');
  db.prepare(
    `UPDATE reply_templates SET draft_ar = @ar, draft_en = @en, status = 'draft',
       updated_at = datetime('now'), updated_by = @updatedBy WHERE key = @key`,
  ).run({ key, ar, en, updatedBy });
  return getTemplate(key, db)!;
}

/** Promotes the draft (or the supplied text) to live. This is the only way live content changes. */
export function publishTemplate(
  key: string,
  input: { ar?: unknown; en?: unknown } | undefined,
  updatedBy: string,
  db: Database.Database = getDb(),
): ReplyTemplate {
  const current = getTemplate(key, db);
  if (!current) throw new TemplateValidationError('Template not found');
  const ar = assertText(input?.ar ?? current.draftAr ?? current.liveAr, 'Arabic content');
  const en = assertText(input?.en ?? current.draftEn ?? current.liveEn, 'English content');
  db.prepare(
    `UPDATE reply_templates SET live_ar = @ar, live_en = @en, draft_ar = NULL, draft_en = NULL,
       status = 'published', updated_at = datetime('now'), updated_by = @updatedBy WHERE key = @key`,
  ).run({ key, ar, en, updatedBy });
  return getTemplate(key, db)!;
}

/** Discards the draft without touching live content. */
export function discardTemplateDraft(key: string, db: Database.Database = getDb()): ReplyTemplate {
  if (!getTemplate(key, db)) throw new TemplateValidationError('Template not found');
  db.prepare(
    `UPDATE reply_templates SET draft_ar = NULL, draft_en = NULL, status = 'published', updated_at = datetime('now') WHERE key = ?`,
  ).run(key);
  return getTemplate(key, db)!;
}

/** Restores the shipped default as the live text and clears any draft. */
export function resetTemplateToDefault(key: string, updatedBy: string, db: Database.Database = getDb()): ReplyTemplate {
  if (!getTemplate(key, db)) throw new TemplateValidationError('Template not found');
  db.prepare(
    `UPDATE reply_templates SET live_ar = default_ar, live_en = default_en, draft_ar = NULL, draft_en = NULL,
       status = 'published', updated_at = datetime('now'), updated_by = @updatedBy WHERE key = @key`,
  ).run({ key, updatedBy });
  return getTemplate(key, db)!;
}

export interface TemplateVars {
  name?: string | null;
  business?: string;
  maps?: string;
  hours?: string;
  /** Request reference (APT-/INQ-…) for appointment and quotation confirmations. */
  reference?: string;
  /** Business address ({address}); defaults to the published business settings in the message language. */
  address?: string;
  /** Currently customer-visible offers ({offers}); defaults to the live offers resolver. */
  offers?: string;
  /** Location notes ({notes}) in the message language. */
  notes?: string;
  /** Request fields ({service} {date} {time} {vehicle} {details} {customer} {status} {kind} {actor}). */
  service?: string;
  date?: string;
  time?: string;
  vehicle?: string;
  details?: string;
  customer?: string;
  status?: string;
  kind?: string;
  actor?: string;
  /** Language used for the data-driven placeholders (hours/address/offers). */
  language?: CustomerLanguage;
}

/** Sample values the dashboard preview substitutes — same renderer as the live path. */
export const PREVIEW_VARS: TemplateVars = {
  name: 'Ahmed', reference: 'APT-2026-1234', service: 'PPF front-end', date: 'Tuesday 23 Sep', time: '10:00 AM', vehicle: 'Toyota Camry 2024',
  details: 'Name: Ahmed\nVehicle make: Toyota\nVehicle model: Camry\nYear: 2024\nService: PPF front-end\nRequested date: Tuesday 23 Sep\nRequested time: 10:00 AM\nNotes: none',
  customer: '********2792', status: 'Confirmed', kind: 'Appointment', actor: 'Dashboard',
};

/** Placeholders whose value comes from live data rather than the template text. */
export const DATA_PLACEHOLDERS = ['business', 'maps', 'hours', 'address', 'notes', 'offers'] as const;

export function templateSourceType(text: string): 'static' | 'data-driven' {
  return /\{(maps|hours|address|notes|offers|business)\}/.test(text) ? 'data-driven' : 'static';
}

const EMPTY_MARK = '\u2060';

/** True for "Label:" / "🅿️" / whitespace — a line left with no value after placeholder substitution. */
function isLabelOnly(line: string): boolean {
  const stripped = line.replace(/[\s\p{Extended_Pictographic}\uFE0F\u200D]/gu, '');
  return stripped === '' || /^[^:\n]{0,60}:$/.test(stripped);
}

export function renderTemplateText(text: string, vars: TemplateVars = {}): string {
  const settings = getBusinessSettings();
  const language: CustomerLanguage = vars.language ?? 'en';
  const values: Record<string, string> = {
    name: (vars.name ?? '').trim(),
    business: vars.business ?? (language === 'ar' ? settings.businessNameAr ?? settings.businessName : settings.businessName),
    maps: vars.maps ?? settings.googleMapsUrl,
    hours: vars.hours ?? formatBusinessHours(settings, language),
    address: vars.address ?? formatAddress(settings, language),
    reference: vars.reference ?? '',
    notes: vars.notes ?? ((language === 'ar' ? settings.locationNotesAr ?? settings.locationNotesEn : settings.locationNotesEn ?? settings.locationNotesAr) ?? ''),
    offers: vars.offers ?? (/\{offers\}/.test(text) ? renderCustomerOffers(language) : ''),
    service: vars.service ?? '', date: vars.date ?? '', time: vars.time ?? '', vehicle: vars.vehicle ?? '', details: vars.details ?? '',
    customer: vars.customer ?? '', status: vars.status ?? '', kind: vars.kind ?? '', actor: vars.actor ?? '',
  };
  return text
    .replace(/\{(name|business|maps|hours|address|notes|reference|offers|service|date|time|vehicle|details|customer|status|kind|actor)\}/g, (_, k: string) => values[k] || EMPTY_MARK)
    // A line whose only content was an empty placeholder ("Location: ", "🅿️ ") is dropped so
    // customers never see dangling labels. Lines with real text keep their text.
    .split('\n')
    .filter((line) => !(line.includes(EMPTY_MARK) && isLabelOnly(line.split(EMPTY_MARK).join(''))))
    .join('\n')
    .split(EMPTY_MARK)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    // An empty {name} would leave "Hello , welcome" / "أهلاً  في" — tidy the gap.
    .replace(/ +,/g, ',')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** The live message resolver. Reads live_* only — drafts are never sent to customers. */
export function resolveTemplate(
  key: string,
  language: CustomerLanguage,
  vars: TemplateVars = {},
  db: Database.Database = getDb(),
): string {
  const template = getTemplate(key, db);
  if (!template) throw new Error(`Unknown reply template: ${key}`);
  const text = language === 'ar' ? template.liveAr : template.liveEn;
  return renderTemplateText(text, { ...vars, language });
}
