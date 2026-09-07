import { DateTime } from 'luxon';
import { env } from '../config/env';
import { getCalendarClient } from './googleClient';
import { freeBusyQuery } from './availability';
import { withRetry } from '../utils/retry';
import { logger } from '../logger';

export interface CreateEventParams {
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
}

export interface CreateEventResult {
  success: true;
  eventId: string;
  htmlLink?: string | null;
}

export interface CreateEventConflict {
  success: false;
  conflict: true;
}

/**
 * Re-checks the exact requested slot against live freebusy data immediately
 * before creating the event (closing the race window between "available"
 * being shown to the customer and the confirm message arriving), then
 * creates the event via events.insert. Never reports success unless Google
 * Calendar actually confirms the event was created.
 */
export async function createEvent(
  params: CreateEventParams,
): Promise<CreateEventResult | CreateEventConflict> {
  const busy = await freeBusyQuery(params.startISO, params.endISO);
  const requestedStart = DateTime.fromISO(params.startISO);
  const requestedEnd = DateTime.fromISO(params.endISO);

  const hasConflict = busy.some((b) => {
    const busyStart = DateTime.fromISO(b.start);
    const busyEnd = DateTime.fromISO(b.end);
    return requestedStart < busyEnd && busyStart < requestedEnd;
  });

  if (hasConflict) {
    logger.warn({ params }, 'booking conflict detected on final availability re-check');
    return { success: false, conflict: true };
  }

  const calendar = getCalendarClient();

  const response = await withRetry(
    () =>
      calendar.events.insert({
        calendarId: env.GOOGLE_CALENDAR_ID,
        requestBody: {
          summary: params.summary,
          description: params.description,
          start: { dateTime: params.startISO, timeZone: env.BUSINESS_TIMEZONE },
          end: { dateTime: params.endISO, timeZone: env.BUSINESS_TIMEZONE },
        },
      }),
    {
      retries: 1,
      onRetry: (error, attempt) => logger.warn({ error, attempt }, 'retrying Google events.insert'),
    },
  );

  if (!response.data.id) {
    throw new Error('Google Calendar did not return an event id after insert');
  }

  logger.info({ eventId: response.data.id }, 'created Google Calendar event');
  return { success: true, eventId: response.data.id, htmlLink: response.data.htmlLink };
}
