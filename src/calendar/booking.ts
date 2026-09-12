import { DateTime } from 'luxon';
import { env } from '../config/env';
import { getCalendarClient } from './googleClient';
import { freeBusyQuery } from './availability';
import { logger } from '../logger';
import { createEventMock } from './mockProvider';
import { isConfirmedGoogleFailure } from './googleErrorClassifier';
import {
  acquireLock,
  confirmLock,
  releaseLock,
  markUncertain,
  findConfirmedByIdempotencyKey,
  buildIdempotencyKey,
  buildSlotKey,
} from '../memory/bookingLockRepo';

export interface CreateEventParams {
  conversationId: number;
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
 * The Google call's outcome could not be determined (network error, abort,
 * or timeout) — Google may or may not have actually created the event. This
 * is deliberately NOT the same as `conflict`: the slot is not necessarily
 * taken by someone else, and NOT the same as a normal failure: we must not
 * imply it's safe to just try again. The caller must not claim success, and
 * must not silently retry — the underlying booking_locks row stays reserved
 * until a human reconciles it against the real calendar.
 */
export interface CreateEventUncertain {
  success: false;
  uncertain: true;
}

export type CreateEventOutcome = CreateEventResult | CreateEventConflict | CreateEventUncertain;

/**
 * Creates a Google Calendar event, protected end-to-end by a database-backed
 * idempotency/slot-lock (src/memory/bookingLockRepo.ts):
 *
 *   1. A genuine RETRY of the exact same logical request (same conversation,
 *      slot, and summary) returns the already-confirmed result instead of
 *      calling Google again.
 *   2. Two different customers racing for the same exact slot can only have
 *      one of them win the lock — the other is told the slot is unavailable
 *      *before* ever calling Google (SQLite's UNIQUE constraint makes the
 *      single claiming INSERT atomic even under concurrent requests).
 *   3. An AMBIGUOUS outcome (network error/timeout on the insert call — see
 *      src/calendar/googleErrorClassifier.ts) never releases the lock and
 *      never claims success or a clean failure — it's marked 'uncertain'
 *      and surfaces as such, because we genuinely do not know whether
 *      Google created the event.
 *
 * Explicit limit: Google's Calendar API has no native idempotency-key
 * support. A process crash in the exact window between Google confirming
 * the insert and our confirmLock() write is the one gap this cannot close
 * without a distributed transaction — minimized by writing the confirmation
 * at the earliest possible point, but not eliminable. This is a genuine,
 * documented residual risk, not something this code claims to solve.
 */
export async function createEvent(params: CreateEventParams): Promise<CreateEventOutcome> {
  if (env.shouldUseMockProviders) {
    return createEventMock(params);
  }

  const idempotencyKey = buildIdempotencyKey(
    params.conversationId,
    params.startISO,
    params.endISO,
    params.summary,
  );

  const alreadyConfirmed = findConfirmedByIdempotencyKey(idempotencyKey);
  if (alreadyConfirmed?.calendar_event_id) {
    logger.info(
      { idempotencyKey, eventId: alreadyConfirmed.calendar_event_id },
      'booking request already confirmed previously — returning cached result, no new Google Calendar call',
    );
    return { success: true, eventId: alreadyConfirmed.calendar_event_id };
  }

  const slotKey = buildSlotKey(env.GOOGLE_CALENDAR_ID, params.startISO, params.endISO);
  const lockResult = acquireLock({
    slotKey,
    idempotencyKey,
    conversationId: params.conversationId,
    startISO: params.startISO,
    endISO: params.endISO,
  });

  if (!lockResult.acquired) {
    if (lockResult.reason === 'now_confirmed' && lockResult.lock.calendar_event_id) {
      logger.info(
        { idempotencyKey, eventId: lockResult.lock.calendar_event_id },
        'a concurrent attempt for this exact request already confirmed it — returning that result',
      );
      return { success: true, eventId: lockResult.lock.calendar_event_id };
    }
    if (lockResult.reason === 'uncertain_retry') {
      logger.error(
        { idempotencyKey, lockId: lockResult.lock.id },
        'refusing to retry: a previous attempt for this exact booking has an unknown outcome and requires manual reconciliation against the real calendar',
      );
      return { success: false, uncertain: true };
    }
    logger.warn({ params, reason: lockResult.reason }, 'booking lock not acquired — treating as conflict');
    return { success: false, conflict: true };
  }

  // Re-check the exact requested slot against live freebusy data immediately
  // before creating the event, closing the race window between "available"
  // being shown to the customer and the confirm message arriving. This is a
  // read-only call — any failure here is a clean, confirmed failure (no
  // ambiguity about whether it "secretly wrote" anything), so releasing the
  // lock is always safe.
  let busy;
  try {
    busy = await freeBusyQuery(params.startISO, params.endISO);
  } catch (error) {
    releaseLock(lockResult.lock.id);
    throw error;
  }

  const requestedStart = DateTime.fromISO(params.startISO);
  const requestedEnd = DateTime.fromISO(params.endISO);
  const hasConflict = busy.some((b) => {
    const busyStart = DateTime.fromISO(b.start);
    const busyEnd = DateTime.fromISO(b.end);
    return requestedStart < busyEnd && busyStart < requestedEnd;
  });

  if (hasConflict) {
    logger.warn({ params }, 'booking conflict detected on final availability re-check');
    releaseLock(lockResult.lock.id);
    return { success: false, conflict: true };
  }

  const calendar = getCalendarClient();

  // Deliberately NOT wrapped in withRetry: events.insert is not idempotent,
  // and any failure here needs to be individually classified (see below) —
  // a blind retry could create a duplicate before we even get to classify
  // the first attempt's outcome.
  let response;
  try {
    response = await calendar.events.insert({
      calendarId: env.GOOGLE_CALENDAR_ID,
      requestBody: {
        summary: params.summary,
        description: params.description,
        start: { dateTime: params.startISO, timeZone: env.BUSINESS_TIMEZONE },
        end: { dateTime: params.endISO, timeZone: env.BUSINESS_TIMEZONE },
      },
    });
  } catch (error) {
    if (isConfirmedGoogleFailure(error)) {
      // Google definitively rejected the request before creating anything.
      releaseLock(lockResult.lock.id);
      throw error;
    }
    // Ambiguous: a network error, timeout, or abort. Google may have
    // actually created the event before we lost the response. We must not
    // release the lock (that would let a retry create a real duplicate) and
    // must not claim success. Mark it for manual reconciliation instead.
    markUncertain(lockResult.lock.id);
    logger.error(
      { error, idempotencyKey, lockId: lockResult.lock.id },
      'ambiguous outcome creating Google Calendar event (network/timeout) — marked uncertain, NOT retried automatically, requires manual reconciliation',
    );
    return { success: false, uncertain: true };
  }

  if (!response.data.id) {
    // Google responded successfully but somehow returned no id — treat the
    // same as a confirmed failure (the 2xx response itself is unambiguous).
    releaseLock(lockResult.lock.id);
    throw new Error('Google Calendar did not return an event id after insert');
  }

  // Persist the confirmation immediately — the earliest possible point,
  // minimizing the crash-window gap described above.
  confirmLock(lockResult.lock.id, response.data.id);

  logger.info({ eventId: response.data.id }, 'created Google Calendar event');
  return { success: true, eventId: response.data.id, htmlLink: response.data.htmlLink };
}
