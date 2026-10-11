/**
 * What a real estate enquiry may contain, and what counts as "enough to hand to a person".
 *
 * Answers are short text typed by the customer (or summarised by the assistant): they are validated here so nothing unbounded or
 * sensitive reaches the database. Identity numbers, bank and card numbers are never stored — the customer is asked not to send them.
 */

export const LEAD_KINDS = ['buyer', 'seller', 'investor', 'general'] as const;
export type LeadKind = (typeof LEAD_KINDS)[number];

export const LEAD_STATUSES = ['new', 'qualified', 'awaiting_info', 'assigned', 'follow_up', 'closed'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
/** Statuses the assistant moves between by itself. Anything staff set (assigned, follow_up, closed) is never overwritten by the assistant. */
export const AUTO_STATUSES: readonly LeadStatus[] = ['new', 'awaiting_info', 'qualified'];

export const DOCUMENT_STATUSES = ['not_requested', 'requested', 'received', 'reviewed'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** The only keys an enquiry can carry (each a short text). */
export const FIELD_KEYS = [
  'property_type', 'city', 'district', 'purpose', 'budget', 'currency', 'bedrooms', 'size', 'completion_preference', 'financing', 'timeframe',
  'ownership_status', 'authorized_to_sell', 'asking_price', 'occupancy', 'service_interest', 'callback_time', 'contact_name', 'preferred_contact', 'notes',
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export const FIELD_LABELS: Record<FieldKey, string> = {
  property_type: 'Property type', city: 'City', district: 'District / area', purpose: 'Purpose (own use / rental / investment)', budget: 'Budget', currency: 'Currency',
  bedrooms: 'Bedrooms', size: 'Size', completion_preference: 'Completed or off-plan', financing: 'Payment / financing', timeframe: 'Timeframe',
  ownership_status: 'Ownership status', authorized_to_sell: 'Authorised to sell', asking_price: 'Expected asking price', occupancy: 'Occupancy / completion',
  service_interest: 'Wants (valuation / marketing / brokerage)', callback_time: 'Preferred callback time', contact_name: 'Name', preferred_contact: 'Preferred contact method', notes: 'Notes',
};

/** The order the assistant asks in (one or two at a time, only what is still missing). */
const ASK_ORDER: Record<LeadKind, FieldKey[]> = {
  buyer: ['property_type', 'city', 'purpose', 'budget', 'bedrooms', 'completion_preference', 'financing', 'timeframe', 'contact_name', 'preferred_contact'],
  seller: ['property_type', 'city', 'size', 'bedrooms', 'ownership_status', 'authorized_to_sell', 'asking_price', 'occupancy', 'service_interest', 'callback_time', 'contact_name'],
  investor: ['property_type', 'city', 'purpose', 'budget', 'timeframe', 'contact_name', 'preferred_contact'],
  general: ['service_interest', 'contact_name', 'preferred_contact', 'callback_time'],
};

/** Enough for a person to act on: until these are present the enquiry waits for information. */
const QUALIFYING: Record<LeadKind, FieldKey[]> = {
  buyer: ['property_type', 'city', 'budget'],
  seller: ['property_type', 'city', 'ownership_status'],
  investor: ['property_type', 'budget'],
  general: ['service_interest'],
};

const MAX_VALUE = 300;
// Never stored: bank (IBAN) numbers, card-like digit runs, and — in free-text fields — 10-digit national ID / residence numbers.
const IBAN = /\bSA\d{2}\s?(?:\d{4}\s?){4,5}\d{0,4}\b/i;
const CARD_LIKE = /(?:\d[ -]?){13,19}/;
const NATIONAL_ID = /(?<![\d.,])[12]\d{9}(?![\d.,])/;
const FREE_TEXT_FIELDS = new Set<FieldKey>(['notes', 'contact_name', 'preferred_contact', 'callback_time', 'ownership_status', 'authorized_to_sell', 'occupancy', 'service_interest']);

export interface SanitizedFields {
  fields: Partial<Record<FieldKey, string>>;
  /** Keys that were not accepted (unknown key, too long once trimmed to nothing, wrong type). */
  rejected: string[];
  /** True when something that looks like an identity number, IBAN or card number was offered: nothing is stored from that field. */
  sensitive: boolean;
}

export function sanitizeFields(input: unknown): SanitizedFields {
  const out: SanitizedFields = { fields: {}, rejected: [], sensitive: false };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!(FIELD_KEYS as readonly string[]).includes(key)) { out.rejected.push(key); continue; }
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'string' && typeof raw !== 'number') { out.rejected.push(key); continue; }
    const value = String(raw).replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE);
    if (!value) continue;
    const k = key as FieldKey;
    if (IBAN.test(value) || ((k === 'notes' || k === 'contact_name') && CARD_LIKE.test(value) && value.replace(/\D/g, '').length >= 13) || (FREE_TEXT_FIELDS.has(k) && NATIONAL_ID.test(value))) {
      out.sensitive = true;
      out.rejected.push(key);
      continue;
    }
    out.fields[k] = value;
  }
  return out;
}

export function missingFields(kind: LeadKind, details: Record<string, string>): FieldKey[] {
  return ASK_ORDER[kind].filter((key) => !details[key]);
}

export function isQualified(kind: LeadKind, details: Record<string, string>): boolean {
  return QUALIFYING[kind].every((key) => Boolean(details[key]));
}

export function nextQuestions(kind: LeadKind, details: Record<string, string>, limit = 2): FieldKey[] {
  return missingFields(kind, details).slice(0, limit);
}

export function parseDetails(raw: string | null | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([k, v]) => (FIELD_KEYS as readonly string[]).includes(k) && typeof v === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}
