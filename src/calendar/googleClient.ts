import { google } from 'googleapis';
import { env } from '../config/env';

let cachedCalendar: ReturnType<typeof google.calendar> | null = null;

/**
 * Lazily builds an authenticated Google Calendar v3 client using a service
 * account (JWT auth — no interactive OAuth consent flow). The target
 * calendar (GOOGLE_CALENDAR_ID) must be shared with GOOGLE_CLIENT_EMAIL
 * ("Make changes to events") for this to be able to read/write it.
 */
export function getCalendarClient(): ReturnType<typeof google.calendar> {
  if (cachedCalendar) return cachedCalendar;

  const auth = new google.auth.JWT({
    email: env.GOOGLE_CLIENT_EMAIL,
    key: env.GOOGLE_PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  cachedCalendar = google.calendar({ version: 'v3', auth });
  return cachedCalendar;
}

/** Test-only hook to reset the cached client between test cases. */
export function resetCalendarClientCache(): void {
  cachedCalendar = null;
}
