import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { logger } from '../logger';
import { listAccounts } from '../accounts/accountRepo';
import { runWithAccount } from '../accounts/accountContext';
import { getBusinessSettings } from '../config/businessSettings';
import { changeRequestStatus } from '../requests/requestService';

/**
 * Automatic expiry of quotations.
 *
 * Only a quotation that is "sent" can expire, and only when the version that was actually delivered carries a valid YYYY-MM-DD
 * validity date that is already behind us in the business's own timezone (the date itself is the last valid day). A quotation without
 * a date, with a malformed date, or in any other status (rejected, cancelled, completed, closed, expired, still being prepared) is never
 * touched. Newer drafts do not matter: once staff start a new version the request leaves "sent" by itself, so there is nothing to expire.
 *
 * The move goes through changeRequestStatus, so it is idempotent (a second run finds nothing), keeps the version history and the sent
 * version intact, writes an audit event with the reason and a system actor, and never messages the customer: an expiry is a quiet
 * bookkeeping change. (Staff get the ordinary status-change alert, once per event.)
 */

export interface ExpiryResult {
  checked: number;
  expired: { accountId: number; requestId: number; reference: string; validUntil: string }[];
}

/** Today's date, YYYY-MM-DD, in an IANA timezone. */
export function dateInTimezone(timezone: string, now: Date = new Date()): string {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((p) => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

function isRealDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

interface SentRow {
  id: number;
  reference: string;
  valid_until: string | null;
}

export function expireDueQuotations(now: Date = new Date(), db: Database.Database = getDb()): ExpiryResult {
  const result: ExpiryResult = { checked: 0, expired: [] };
  for (const account of listAccounts(db)) {
    runWithAccount(account.id, () => {
      const timezone = getBusinessSettings(account.id).businessTimezone;
      const today = dateInTimezone(timezone, now);
      // The validity of the version that was actually delivered: the latest version with a delivery timestamp.
      const rows = db.prepare(
        `SELECT r.id, r.reference,
                (SELECT v.valid_until FROM quotation_versions v
                  WHERE v.request_id = r.id AND v.whatsapp_account_id = r.whatsapp_account_id AND v.sent_at IS NOT NULL
                  ORDER BY v.version DESC LIMIT 1) AS valid_until
           FROM customer_requests r
          WHERE r.whatsapp_account_id = ? AND r.kind = 'quotation' AND r.status = 'sent'`,
      ).all(account.id) as SentRow[];
      for (const row of rows) {
        result.checked++;
        if (!isRealDate(row.valid_until) || row.valid_until >= today) continue;
        try {
          const changed = changeRequestStatus(row.id, 'expired', { type: 'system', detail: 'validity date passed' }, db, account.id, { reason: `Validity date ${row.valid_until} has passed (business timezone ${timezone})` });
          if (changed?.changed) result.expired.push({ accountId: account.id, requestId: row.id, reference: row.reference, validUntil: row.valid_until });
        } catch (error) {
          logger.warn({ error, account: account.id, requestId: row.id }, '[QUOTATION] automatic expiry failed for one request');
        }
      }
    });
  }
  if (result.expired.length) logger.info({ count: result.expired.length }, '[QUOTATION] quotations expired automatically');
  return result;
}
