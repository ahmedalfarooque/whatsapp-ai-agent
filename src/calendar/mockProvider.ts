import { logger } from '../logger';
import type { BusyInterval } from './availability';
import type { CreateEventParams, CreateEventResult } from './booking';

/**
 * Mock Google Calendar provider used whenever env.shouldUseMockProviders is
 * true (i.e. NODE_ENV !== 'production'). Never calls googleapis / Google's
 * servers, and never constructs a real service-account client — safe to run
 * with no Google credentials configured at all.
 */
export function freeBusyQueryMock(startISO: string, endISO: string): Promise<BusyInterval[]> {
  logger.info(
    { startISO, endISO },
    '[MOCK Calendar] returning an empty busy list (everything free) — development mode, no real Google Calendar call',
  );
  return Promise.resolve([]);
}

export function createEventMock(params: CreateEventParams): Promise<CreateEventResult> {
  logger.info(
    { params },
    '[MOCK Calendar] would create this event — development mode, no real Google Calendar event created',
  );
  return Promise.resolve({
    success: true,
    eventId: `mock-event-${Date.now()}`,
    htmlLink: null,
  });
}
