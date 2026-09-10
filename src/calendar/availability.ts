import { DateTime } from 'luxon';
import { env } from '../config/env';
import { getCalendarClient } from './googleClient';
import { businessHoursRangeFor, isBusinessDay } from './timezone';
import { withRetry } from '../utils/retry';
import { logger } from '../logger';
import { freeBusyQueryMock } from './mockProvider';

export interface BusyInterval {
  start: string;
  end: string;
}

/**
 * Queries Google Calendar's freebusy.query (current v3 endpoint) for the
 * configured calendar between startISO and endISO. Returns real busy
 * intervals — never guesses or fabricates availability.
 */
export async function freeBusyQuery(startISO: string, endISO: string): Promise<BusyInterval[]> {
  if (env.shouldUseMockProviders) {
    return freeBusyQueryMock(startISO, endISO);
  }

  const calendar = getCalendarClient();

  const response = await withRetry(
    () =>
      calendar.freebusy.query({
        requestBody: {
          timeMin: startISO,
          timeMax: endISO,
          timeZone: env.BUSINESS_TIMEZONE,
          items: [{ id: env.GOOGLE_CALENDAR_ID }],
        },
      }),
    {
      retries: 2,
      onRetry: (error, attempt) => logger.warn({ error, attempt }, 'retrying Google freebusy.query'),
    },
  );

  const calendarBusy = response.data.calendars?.[env.GOOGLE_CALENDAR_ID]?.busy ?? [];
  return calendarBusy
    .filter((b) => b.start && b.end)
    .map((b) => ({ start: b.start as string, end: b.end as string }));
}

function overlaps(aStart: DateTime, aEnd: DateTime, bStart: DateTime, bEnd: DateTime): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Computes free start times on `dateISO` (business-local YYYY-MM-DD), sliced
 * every `durationMinutes` within configured business hours, excluding any
 * slot that overlaps a busy interval or a buffer around one.
 */
export function computeFreeSlots(
  dateISO: string,
  durationMinutes: number,
  busy: BusyInterval[],
  bufferMinutes: number,
): DateTime[] {
  const dayStart = DateTime.fromISO(dateISO, { zone: env.BUSINESS_TIMEZONE });
  if (!isBusinessDay(dayStart)) return [];

  const { start: hoursStart, end: hoursEnd } = businessHoursRangeFor(dayStart);
  const now = DateTime.now().setZone(env.BUSINESS_TIMEZONE);

  const busyIntervals = busy.map((b) => ({
    start: DateTime.fromISO(b.start).minus({ minutes: bufferMinutes }),
    end: DateTime.fromISO(b.end).plus({ minutes: bufferMinutes }),
  }));

  const slots: DateTime[] = [];
  let cursor = hoursStart;

  while (cursor.plus({ minutes: durationMinutes }) <= hoursEnd) {
    const slotEnd = cursor.plus({ minutes: durationMinutes });
    const isPast = cursor < now;
    const isBusy = busyIntervals.some((b) => overlaps(cursor, slotEnd, b.start, b.end));

    if (!isPast && !isBusy) {
      slots.push(cursor);
    }
    cursor = cursor.plus({ minutes: durationMinutes });
  }

  return slots;
}

export async function findFreeSlots(
  dateISO: string,
  durationMinutes: number = env.BOOKING_DURATION_MINUTES,
): Promise<DateTime[]> {
  const dayStart = DateTime.fromISO(dateISO, { zone: env.BUSINESS_TIMEZONE }).startOf('day');
  const dayEnd = dayStart.endOf('day');

  const busy = await freeBusyQuery(dayStart.toISO() as string, dayEnd.toISO() as string);
  return computeFreeSlots(dateISO, durationMinutes, busy, env.BOOKING_BUFFER_MINUTES);
}
