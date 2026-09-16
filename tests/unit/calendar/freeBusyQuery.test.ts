import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../../src/config/env')>(
    '../../../src/config/env',
  );
  return {
    ...actual,
    env: {
      ...actual.env,
      shouldUseMockProviders: false,
      shouldUseMockCalendarProviders: false,
    },
  };
});

const query = vi.fn();
vi.mock('../../../src/calendar/googleClient', () => ({
  getCalendarClient: () => ({ freebusy: { query } }),
}));

import { freeBusyQuery } from '../../../src/calendar/availability';

describe('freeBusyQuery — real Google Calendar path', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('parses busy intervals from a successful response', async () => {
    query.mockResolvedValue({
      data: { calendars: { primary: { busy: [{ start: '2025-01-01T10:00:00Z', end: '2025-01-01T10:30:00Z' }] } } },
    });

    const busy = await freeBusyQuery('2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');
    expect(busy).toEqual([{ start: '2025-01-01T10:00:00Z', end: '2025-01-01T10:30:00Z' }]);
  });

  it('returns an empty list when the calendar has no busy entries (never fabricates busy time)', async () => {
    query.mockResolvedValue({ data: { calendars: {} } });
    const busy = await freeBusyQuery('2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');
    expect(busy).toEqual([]);
  });

  it('retries on a transient Google API error and eventually succeeds', async () => {
    query
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ data: { calendars: {} } });

    const busy = await freeBusyQuery('2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');
    expect(query).toHaveBeenCalledTimes(2);
    expect(busy).toEqual([]);
  });

  it('gives up and throws after repeated failures rather than silently reporting "all free"', async () => {
    query.mockRejectedValue(new Error('Google API down'));

    await expect(freeBusyQuery('2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z')).rejects.toThrow(
      'Google API down',
    );
  });
});
