import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';

/**
 * The appointment / enquiry types a business offers inside "request a callback" and "request a WhatsApp message" (table
 * account_appointment_types, migration 025). Every business has its own list; the four generic defaults below are only a starting point
 * — administrators replace them with the types that fit the business (consultation, property viewing, quotation discussion, ...).
 */

export interface AppointmentType {
  id: number;
  key: string;
  labelEn: string;
  labelAr: string;
  enabled: boolean;
  sortOrder: number;
}

export interface AppointmentTypeInput {
  key: string;
  labelEn: string;
  labelAr: string;
  enabled?: boolean;
}

export const DEFAULT_APPOINTMENT_TYPES: readonly AppointmentTypeInput[] = [
  { key: 'consultation', labelEn: 'Consultation', labelAr: 'استشارة' },
  { key: 'service_enquiry', labelEn: 'Service enquiry', labelAr: 'استفسار عن خدمة' },
  { key: 'product_enquiry', labelEn: 'Product enquiry', labelAr: 'استفسار عن منتج' },
  { key: 'quotation_discussion', labelEn: 'Quotation discussion', labelAr: 'مناقشة عرض سعر' },
];

export const MAX_APPOINTMENT_TYPES = 12;
const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

export class AppointmentTypeError extends Error {
  status = 400;
}

interface Row { id: number; key: string; label_en: string; label_ar: string; enabled: number; sort_order: number }
const toType = (r: Row): AppointmentType => ({ id: r.id, key: r.key, labelEn: r.label_en, labelAr: r.label_ar, enabled: r.enabled !== 0, sortOrder: r.sort_order });

/** A business that has no types yet (created after the migration) receives the shared defaults. Idempotent. */
export function ensureAppointmentTypes(accountId: number = currentAccountId(), db: Database.Database = getDb()): void {
  const n = (db.prepare('SELECT COUNT(*) AS n FROM account_appointment_types WHERE whatsapp_account_id = ?').get(accountId) as { n: number }).n;
  if (n > 0) return;
  const insert = db.prepare('INSERT OR IGNORE INTO account_appointment_types (whatsapp_account_id, key, label_en, label_ar, sort_order) VALUES (?, ?, ?, ?, ?)');
  DEFAULT_APPOINTMENT_TYPES.forEach((t, i) => insert.run(accountId, t.key, t.labelEn, t.labelAr, i + 1));
}

export function listAppointmentTypes(accountId: number = currentAccountId(), opts: { enabledOnly?: boolean } = {}, db: Database.Database = getDb()): AppointmentType[] {
  ensureAppointmentTypes(accountId, db);
  return (db
    .prepare(`SELECT * FROM account_appointment_types WHERE whatsapp_account_id = ? ${opts.enabledOnly ? 'AND enabled = 1' : ''} ORDER BY sort_order, id`)
    .all(accountId) as Row[]).map(toType);
}

export function getAppointmentType(key: string, accountId: number = currentAccountId(), db: Database.Database = getDb()): AppointmentType | undefined {
  const r = db.prepare('SELECT * FROM account_appointment_types WHERE whatsapp_account_id = ? AND key = ?').get(accountId, key) as Row | undefined;
  return r ? toType(r) : undefined;
}

/** Replaces the whole list of one business (order = sort order). Validates everything before writing anything. */
export function saveAppointmentTypes(raw: unknown, accountId: number = currentAccountId(), db: Database.Database = getDb()): AppointmentType[] {
  if (!Array.isArray(raw)) throw new AppointmentTypeError('types must be a list');
  if (raw.length === 0) throw new AppointmentTypeError('at least one appointment type is required');
  if (raw.length > MAX_APPOINTMENT_TYPES) throw new AppointmentTypeError(`at most ${MAX_APPOINTMENT_TYPES} appointment types`);
  const items: AppointmentTypeInput[] = [];
  const keys = new Set<string>();
  for (const [i, item] of (raw as unknown[]).entries()) {
    if (!item || typeof item !== 'object') throw new AppointmentTypeError(`type ${i + 1} is invalid`);
    const o = item as Record<string, unknown>;
    const key = String(o.key ?? '').trim().toLowerCase();
    const labelEn = String(o.labelEn ?? '').trim();
    const labelAr = String(o.labelAr ?? '').trim();
    if (!KEY_RE.test(key)) throw new AppointmentTypeError(`type ${i + 1}: key must be letters, digits and underscores (e.g. property_viewing)`);
    if (keys.has(key)) throw new AppointmentTypeError(`type ${i + 1}: duplicate key ${key}`);
    if (!labelEn || labelEn.length > 60) throw new AppointmentTypeError(`type ${i + 1}: an English label (1-60 characters) is required`);
    if (!labelAr || labelAr.length > 60) throw new AppointmentTypeError(`type ${i + 1}: an Arabic label (1-60 characters) is required`);
    keys.add(key);
    items.push({ key, labelEn, labelAr, enabled: o.enabled === undefined ? true : Boolean(o.enabled) });
  }
  if (!items.some((t) => t.enabled)) throw new AppointmentTypeError('at least one appointment type must be enabled');
  const run = db.transaction(() => {
    db.prepare('DELETE FROM account_appointment_types WHERE whatsapp_account_id = ? AND key NOT IN (' + items.map(() => '?').join(',') + ')').run(accountId, ...items.map((t) => t.key));
    const upsert = db.prepare(
      `INSERT INTO account_appointment_types (whatsapp_account_id, key, label_en, label_ar, enabled, sort_order) VALUES (@accountId, @key, @labelEn, @labelAr, @enabled, @sortOrder)
       ON CONFLICT (whatsapp_account_id, key) DO UPDATE SET label_en = excluded.label_en, label_ar = excluded.label_ar, enabled = excluded.enabled, sort_order = excluded.sort_order, updated_at = datetime('now')`,
    );
    items.forEach((t, i) => upsert.run({ accountId, key: t.key, labelEn: t.labelEn, labelAr: t.labelAr, enabled: t.enabled ? 1 : 0, sortOrder: i + 1 }));
  });
  run();
  return listAppointmentTypes(accountId, {}, db);
}

export function appointmentTypeLabel(type: Pick<AppointmentType, 'labelEn' | 'labelAr'>, language: 'ar' | 'en'): string {
  return language === 'ar' ? type.labelAr : type.labelEn;
}
