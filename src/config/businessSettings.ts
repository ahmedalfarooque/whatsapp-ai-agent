import { z } from 'zod';
import { getDb } from '../memory/db';
import { env } from './env';

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const csvOf = (validate?: (item: string) => boolean) =>
  z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    )
    .refine((items) => items.length > 0, 'must contain at least one value')
    .refine((items) => !validate || items.every(validate), 'contains an invalid value');

export const businessSettingsInputSchema = z
  .object({
    businessName: z.string().min(1).max(200).nullable(),
    businessTimezone: z.string().refine(isValidTimezone, 'not a valid IANA timezone').nullable(),
    businessHoursStart: z.string().regex(HHMM_RE, 'must be HH:mm').nullable(),
    businessHoursEnd: z.string().regex(HHMM_RE, 'must be HH:mm').nullable(),
    businessDays: csvOf((d) => /^[1-7]$/.test(d)).nullable(),
    bookingDurationMinutes: z.number().int().positive().nullable(),
    bookingBufferMinutes: z.number().int().nonnegative().nullable(),
    restartKeywords: csvOf().nullable(),
    conversationHistoryLimit: z.number().int().positive().max(200).nullable(),
    welcomeMessage: z.string().max(2000).nullable(),
    fallbackMessage: z.string().max(2000).nullable(),
    cancellationPolicy: z.string().max(5000).nullable(),
    humanEscalationInfo: z.string().max(2000).nullable(),
    supportedLanguages: csvOf((l) => /^[a-zA-Z]{2,8}$/.test(l)).nullable(),
    openRouterModel: z.string().min(1).max(100).nullable(),
    // ---- business profile & location (dashboard-editable, one resolver for WhatsApp/preview/AI)
    businessNameAr: z.string().max(200).nullable(),
    businessCategory: z.string().max(200).nullable(),
    descriptionAr: z.string().max(3000).nullable(),
    descriptionEn: z.string().max(3000).nullable(),
    addressAr: z.string().max(500).nullable(),
    addressEn: z.string().max(500).nullable(),
    googleMapsUrl: z
      .string()
      .max(500)
      .refine((u) => /^https:\/\/(maps\.app\.goo\.gl|goo\.gl|maps\.google\.[a-z.]+|www\.google\.[a-z.]+\/maps|share\.google)\//i.test(u), 'must be an https Google Maps link')
      .nullable(),
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    fridayHoursStart: z.string().regex(HHMM_RE, 'must be HH:mm').nullable(),
    fridayHoursEnd: z.string().regex(HHMM_RE, 'must be HH:mm').nullable(),
    locationNotesAr: z.string().max(1000).nullable(),
    locationNotesEn: z.string().max(1000).nullable(),
    logoDocumentId: z.number().int().positive().nullable(),
    staffWhatsappNumber: z.string().regex(/^\+?\d{8,15}$/, 'must be an international number like +9665XXXXXXXX').nullable(),
  })
  .partial();

export type BusinessSettingsPatch = z.infer<typeof businessSettingsInputSchema>;

export interface BusinessSettings {
  businessName: string;
  businessTimezone: string;
  businessHoursStart: string;
  businessHoursEnd: string;
  businessDays: number[];
  bookingDurationMinutes: number;
  bookingBufferMinutes: number;
  restartKeywords: string[];
  conversationHistoryLimit: number;
  welcomeMessage: string | null;
  fallbackMessage: string | null;
  cancellationPolicy: string | null;
  humanEscalationInfo: string | null;
  supportedLanguages: string[];
  openRouterModel: string;
  businessNameAr: string | null;
  businessCategory: string | null;
  descriptionAr: string | null;
  descriptionEn: string | null;
  addressAr: string | null;
  addressEn: string | null;
  /** Always set: dashboard value, else the confirmed default link. */
  googleMapsUrl: string;
  latitude: number | null;
  longitude: number | null;
  /** Friday hours; null = same as the normal hours. */
  fridayHoursStart: string | null;
  fridayHoursEnd: string | null;
  locationNotesAr: string | null;
  locationNotesEn: string | null;
  logoDocumentId: number | null;
  /** Optional dedicated number for staff alerts (E.164). Empty = the linked business number's own chat. */
  staffWhatsappNumber: string | null;
}

/** Official Google Maps link for Rowad Alfa Auto Care (overridable from the dashboard). */
export const DEFAULT_GOOGLE_MAPS_URL = 'https://maps.app.goo.gl/8sxNK9wMNsTucvCh7';

/** Per-field: true when the value came from a dashboard override, false when it's the env fallback. */
export type BusinessSettingsOverrides = Record<keyof BusinessSettings, boolean>;

export class BusinessSettingsValidationError extends Error {
  status = 400;
  fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super('Invalid business settings');
    this.fields = fields;
  }
}

interface BusinessSettingsRow {
  business_name: string | null;
  business_timezone: string | null;
  business_hours_start: string | null;
  business_hours_end: string | null;
  business_days: string | null;
  booking_duration_minutes: number | null;
  booking_buffer_minutes: number | null;
  restart_keywords: string | null;
  conversation_history_limit: number | null;
  welcome_message: string | null;
  fallback_message: string | null;
  cancellation_policy: string | null;
  human_escalation_info: string | null;
  supported_languages: string | null;
  open_router_model: string | null;
  business_name_ar: string | null;
  business_category: string | null;
  description_ar: string | null;
  description_en: string | null;
  address_ar: string | null;
  address_en: string | null;
  google_maps_url: string | null;
  latitude: number | null;
  longitude: number | null;
  friday_hours_start: string | null;
  friday_hours_end: string | null;
  location_notes_ar: string | null;
  location_notes_en: string | null;
  logo_document_id: number | null;
  staff_whatsapp_number: string | null;
}

function readRow(): BusinessSettingsRow {
  const row = getDb()
    .prepare(
      `SELECT business_name, business_timezone, business_hours_start, business_hours_end,
              business_days, booking_duration_minutes, booking_buffer_minutes,
              restart_keywords, conversation_history_limit, welcome_message,
              fallback_message, cancellation_policy, human_escalation_info, supported_languages,
              open_router_model,
              business_name_ar, business_category, description_ar, description_en, address_ar, address_en,
              google_maps_url, latitude, longitude, friday_hours_start, friday_hours_end,
              location_notes_ar, location_notes_en, logo_document_id, staff_whatsapp_number
       FROM business_settings WHERE id = 1`,
    )
    .get() as BusinessSettingsRow | undefined;
  // The seed row (INSERT OR IGNORE) is created by the migration itself, so
  // this should always exist — but never silently invent defaults here if
  // it's somehow missing; that would be a schema/migration bug to surface.
  if (!row) throw new Error('business_settings row (id=1) is missing — migrations did not run correctly');
  return row;
}

function csvToList(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Reads settings fresh from SQLite every call — no in-process cache, so a
 * dashboard write is reflected immediately without a process restart. */
export function getBusinessSettings(): BusinessSettings {
  const row = readRow();
  return {
    businessName: row.business_name ?? env.BUSINESS_NAME,
    businessTimezone: row.business_timezone ?? env.BUSINESS_TIMEZONE,
    businessHoursStart: row.business_hours_start ?? env.BUSINESS_HOURS_START,
    businessHoursEnd: row.business_hours_end ?? env.BUSINESS_HOURS_END,
    businessDays: row.business_days ? csvToList(row.business_days).map(Number) : env.BUSINESS_DAYS,
    bookingDurationMinutes: row.booking_duration_minutes ?? env.BOOKING_DURATION_MINUTES,
    bookingBufferMinutes: row.booking_buffer_minutes ?? env.BOOKING_BUFFER_MINUTES,
    restartKeywords: row.restart_keywords ? csvToList(row.restart_keywords) : env.RESTART_KEYWORDS,
    conversationHistoryLimit: row.conversation_history_limit ?? env.CONVERSATION_HISTORY_LIMIT,
    welcomeMessage: row.welcome_message,
    fallbackMessage: row.fallback_message,
    cancellationPolicy: row.cancellation_policy,
    humanEscalationInfo: row.human_escalation_info,
    supportedLanguages: row.supported_languages ? csvToList(row.supported_languages) : [],
    openRouterModel: row.open_router_model ?? env.OPENROUTER_MODEL,
    businessNameAr: row.business_name_ar,
    businessCategory: row.business_category,
    descriptionAr: row.description_ar,
    descriptionEn: row.description_en,
    addressAr: row.address_ar,
    addressEn: row.address_en,
    googleMapsUrl: row.google_maps_url ?? DEFAULT_GOOGLE_MAPS_URL,
    latitude: row.latitude,
    longitude: row.longitude,
    fridayHoursStart: row.friday_hours_start,
    fridayHoursEnd: row.friday_hours_end,
    locationNotesAr: row.location_notes_ar,
    locationNotesEn: row.location_notes_en,
    logoDocumentId: row.logo_document_id,
    staffWhatsappNumber: row.staff_whatsapp_number,
  };
}

const DAY_NAMES: Record<'ar' | 'en', string[]> = {
  en: ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  ar: ['', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد'],
};

/** "09:00" -> "9:00 AM" / "9:00 صباحاً". */
export function formatClock(hhmm: string, language: 'ar' | 'en'): string {
  const parts = hhmm.split(':').map(Number);
  const h = parts[0] ?? NaN;
  const m = parts[1] ?? NaN;
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const suffix = language === 'ar' ? (h < 12 ? 'صباحاً' : h < 17 ? 'ظهراً' : 'مساءً') : h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * Human-readable opening hours in the customer's language, from the published
 * settings. Friday is listed separately when it differs. Used by the {hours}
 * placeholder, the dashboard Location page and the AI prompt — one source.
 */
export function formatBusinessHours(settings: BusinessSettings, language: 'ar' | 'en'): string {
  const days = settings.businessDays.filter((d) => d >= 1 && d <= 7);
  const friday = 5;
  const fridayStart = settings.fridayHoursStart ?? settings.businessHoursStart;
  const fridayEnd = settings.fridayHoursEnd ?? settings.businessHoursEnd;
  const fridayDiffers = days.includes(friday) && (fridayStart !== settings.businessHoursStart || fridayEnd !== settings.businessHoursEnd);
  const regular = fridayDiffers ? days.filter((d) => d !== friday) : days;
  const names = DAY_NAMES[language];
  // Saudi week order: Saturday(6) → Friday(5).
  const order = [6, 7, 1, 2, 3, 4, 5];
  const sorted = [...regular].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const range = sorted.length === 0
    ? ''
    : sorted.length === 1
      ? names[sorted[0]!]!
      : language === 'ar'
        ? `من ${names[sorted[0]!]} إلى ${names[sorted[sorted.length - 1]!]}`
        : `${names[sorted[0]!]} to ${names[sorted[sorted.length - 1]!]}`;
  const lines: string[] = [];
  if (range) lines.push(`• ${range}: ${formatClock(settings.businessHoursStart, language)} - ${formatClock(settings.businessHoursEnd, language)}`);
  if (fridayDiffers) lines.push(`• ${language === 'ar' ? 'يوم الجمعة' : 'Friday'}: ${formatClock(fridayStart, language)} - ${formatClock(fridayEnd, language)}`);
  const closed = [1, 2, 3, 4, 5, 6, 7].filter((d) => !days.includes(d));
  if (closed.length) lines.push(`• ${language === 'ar' ? 'مغلق' : 'Closed'}: ${closed.map((d) => names[d]).join(language === 'ar' ? '، ' : ', ')}`);
  return lines.join('\n');
}

/** Address in the customer's language with a fallback to the other language. */
export function formatAddress(settings: BusinessSettings, language: 'ar' | 'en'): string {
  return (language === 'ar' ? settings.addressAr ?? settings.addressEn : settings.addressEn ?? settings.addressAr) ?? '';
}

/** Per-field override status, for the dashboard's "using default from env" hints. */
export function getBusinessSettingsOverrides(): BusinessSettingsOverrides {
  const row = readRow();
  return {
    businessName: row.business_name !== null,
    businessTimezone: row.business_timezone !== null,
    businessHoursStart: row.business_hours_start !== null,
    businessHoursEnd: row.business_hours_end !== null,
    businessDays: row.business_days !== null,
    bookingDurationMinutes: row.booking_duration_minutes !== null,
    bookingBufferMinutes: row.booking_buffer_minutes !== null,
    restartKeywords: row.restart_keywords !== null,
    conversationHistoryLimit: row.conversation_history_limit !== null,
    welcomeMessage: row.welcome_message !== null,
    fallbackMessage: row.fallback_message !== null,
    cancellationPolicy: row.cancellation_policy !== null,
    humanEscalationInfo: row.human_escalation_info !== null,
    supportedLanguages: row.supported_languages !== null,
    openRouterModel: row.open_router_model !== null,
    businessNameAr: row.business_name_ar !== null,
    businessCategory: row.business_category !== null,
    descriptionAr: row.description_ar !== null,
    descriptionEn: row.description_en !== null,
    addressAr: row.address_ar !== null,
    addressEn: row.address_en !== null,
    googleMapsUrl: row.google_maps_url !== null,
    latitude: row.latitude !== null,
    longitude: row.longitude !== null,
    fridayHoursStart: row.friday_hours_start !== null,
    fridayHoursEnd: row.friday_hours_end !== null,
    locationNotesAr: row.location_notes_ar !== null,
    locationNotesEn: row.location_notes_en !== null,
    logoDocumentId: row.logo_document_id !== null,
    staffWhatsappNumber: row.staff_whatsapp_number !== null,
  };
}

const COLUMN_MAP: Record<keyof BusinessSettingsPatch, string> = {
  businessName: 'business_name',
  businessTimezone: 'business_timezone',
  businessHoursStart: 'business_hours_start',
  businessHoursEnd: 'business_hours_end',
  businessDays: 'business_days',
  bookingDurationMinutes: 'booking_duration_minutes',
  bookingBufferMinutes: 'booking_buffer_minutes',
  restartKeywords: 'restart_keywords',
  conversationHistoryLimit: 'conversation_history_limit',
  welcomeMessage: 'welcome_message',
  fallbackMessage: 'fallback_message',
  cancellationPolicy: 'cancellation_policy',
  humanEscalationInfo: 'human_escalation_info',
  supportedLanguages: 'supported_languages',
  openRouterModel: 'open_router_model',
  businessNameAr: 'business_name_ar',
  businessCategory: 'business_category',
  descriptionAr: 'description_ar',
  descriptionEn: 'description_en',
  addressAr: 'address_ar',
  addressEn: 'address_en',
  googleMapsUrl: 'google_maps_url',
  latitude: 'latitude',
  longitude: 'longitude',
  fridayHoursStart: 'friday_hours_start',
  fridayHoursEnd: 'friday_hours_end',
  locationNotesAr: 'location_notes_ar',
  locationNotesEn: 'location_notes_en',
  logoDocumentId: 'logo_document_id',
  staffWhatsappNumber: 'staff_whatsapp_number',
};

/**
 * Validates the given patch (each field's own rule; `null` means "reset to
 * env default"), then performs one atomic UPDATE. Writes nothing at all if
 * any field fails validation.
 */
export function updateBusinessSettings(patch: unknown): BusinessSettings {
  const result = businessSettingsInputSchema.safeParse(patch);
  if (!result.success) {
    const fields: Record<string, string> = {};
    for (const issue of result.error.issues) {
      fields[String(issue.path[0])] = issue.message;
    }
    throw new BusinessSettingsValidationError(fields);
  }

  const entries = Object.entries(result.data).filter(([, v]) => v !== undefined) as [
    keyof BusinessSettingsPatch,
    string | number | string[] | null,
  ][];
  if (entries.length === 0) return getBusinessSettings();

  const setClauses: string[] = [];
  const params: Record<string, string | number | null> = {};
  for (const [field, value] of entries) {
    const column = COLUMN_MAP[field];
    setClauses.push(`${column} = @${column}`);
    params[column] = Array.isArray(value) ? value.join(',') : value;
  }
  setClauses.push("updated_at = datetime('now')");

  getDb()
    .prepare(`UPDATE business_settings SET ${setClauses.join(', ')} WHERE id = 1`)
    .run(params);

  return getBusinessSettings();
}

/**
 * Rowad Alfa location/hours defaults (from the original Antigravity
 * configuration), written ONLY into columns the dashboard has never set.
 * Called once at server boot — never from tests, so test databases keep the
 * plain env fallbacks. Existing edits always win.
 */
export const ROWAD_ALFA_PROFILE_DEFAULTS: Record<string, string> = {
  business_name: 'Rowad Alfa Auto Care',
  business_name_ar: 'شركة رواد ألفا للعناية بالسيارات',
  business_category: 'Automotive accessories, car audio, car care, tinting & protection',
  address_en: 'Jeddah / Bahrah, Kingdom of Saudi Arabia',
  address_ar: 'المملكة العربية السعودية - جدة / بحرة',
  business_days: '1,2,3,4,5,6,7',
  business_hours_start: '09:00',
  business_hours_end: '22:00',
  friday_hours_start: '16:00',
  friday_hours_end: '22:00',
  location_notes_en: 'Free dedicated customer parking available.',
  location_notes_ar: 'يتوفر مواقف مجانية مخصصة لعملاء المركز.',
};

export function seedBusinessProfileDefaults(): string[] {
  const db = getDb();
  const seeded: string[] = [];
  const run = db.transaction(() => {
    for (const [column, value] of Object.entries(ROWAD_ALFA_PROFILE_DEFAULTS)) {
      const r = db.prepare(`UPDATE business_settings SET ${column} = ? WHERE id = 1 AND ${column} IS NULL`).run(value);
      if (r.changes > 0) seeded.push(column);
    }
  });
  run();
  return seeded;
}
