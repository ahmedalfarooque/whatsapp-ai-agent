import { google } from 'googleapis';
import { getEffectiveCredential } from '../config/effectiveConfig';

/**
 * Builds an authenticated Google Calendar v3 client using a service account
 * (JWT auth — no interactive OAuth consent flow). The target calendar
 * (GOOGLE_CALENDAR_ID) must be shared with GOOGLE_CLIENT_EMAIL ("Make
 * changes to events") for this to be able to read/write it.
 *
 * Built fresh on every call (no module-level cache) rather than cached,
 * because the effective credential can now change at runtime via the
 * dashboard's encrypted credential-override store — caching a client built
 * from a stale credential would silently keep using a rotated-out key.
 */
export function getCalendarClient(): ReturnType<typeof google.calendar> {
  const auth = new google.auth.JWT({
    email: getEffectiveCredential('GOOGLE_CLIENT_EMAIL'),
    key: getEffectiveCredential('GOOGLE_PRIVATE_KEY'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  return google.calendar({ version: 'v3', auth });
}
