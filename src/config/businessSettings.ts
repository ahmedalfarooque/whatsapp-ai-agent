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
}

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
}

function readRow(): BusinessSettingsRow {
  const row = getDb()
    .prepare(
      `SELECT business_name, business_timezone, business_hours_start, business_hours_end,
              business_days, booking_duration_minutes, booking_buffer_minutes,
              restart_keywords, conversation_history_limit, welcome_message,
              fallback_message, cancellation_policy, human_escalation_info, supported_languages
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
  };
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
