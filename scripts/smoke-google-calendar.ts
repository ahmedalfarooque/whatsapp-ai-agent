import { env } from '../src/config/env';
import { freeBusyQuery } from '../src/calendar/availability';
import { getCalendarClient } from '../src/calendar/googleClient';
import { DateTime } from 'luxon';

/* eslint-disable no-console */

async function main(): Promise<void> {
  if (!env.isProduction) throw new Error('Set NODE_ENV=production for the Google Calendar smoke test.');
  if (!env.GOOGLE_CLIENT_EMAIL || !env.GOOGLE_PRIVATE_KEY || !env.GOOGLE_CALENDAR_ID) {
    throw new Error('Google service-account credentials and GOOGLE_CALENDAR_ID are required.');
  }

  const start = DateTime.now().setZone(env.BUSINESS_TIMEZONE).startOf('day');
  const end = start.endOf('day');
  const busy = await freeBusyQuery(start.toISO() as string, end.toISO() as string);

  if (process.env.CONFIRM_LIVE_CALENDAR_WRITE !== 'true') {
    console.log(JSON.stringify({ ok: true, operation: 'availability', calendarId: env.GOOGLE_CALENDAR_ID, busyIntervals: busy.length }));
    return;
  }

  const testCalendarId = process.env.TEST_GOOGLE_CALENDAR_ID;
  if (!testCalendarId) throw new Error('TEST_GOOGLE_CALENDAR_ID is required for a write smoke test.');
  const testStart = start.plus({ days: 1, hours: 1 });
  const testEnd = testStart.plus({ minutes: 15 });
  const created = await getCalendarClient().events.insert({
    calendarId: testCalendarId,
    requestBody: {
      summary: 'WhatsApp AI Agent LIVE SMOKE TEST — DELETE ME',
      description: 'Created only by scripts/smoke-google-calendar.ts.',
      start: { dateTime: testStart.toISO() as string, timeZone: env.BUSINESS_TIMEZONE },
      end: { dateTime: testEnd.toISO() as string, timeZone: env.BUSINESS_TIMEZONE },
    },
  });
  console.log(JSON.stringify({ ok: true, operation: 'write', testCalendarId, eventId: created.data.id ?? null }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Google Calendar smoke test failed');
  process.exitCode = 1;
});
