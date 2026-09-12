import { describe, it, expect } from 'vitest';
import { freeBusyQueryMock, createEventMock } from '../../../src/calendar/mockProvider';

describe('Calendar mock provider', () => {
  it('freeBusyQueryMock always reports nothing busy, without a real Google API call', async () => {
    const busy = await freeBusyQueryMock('2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z');
    expect(busy).toEqual([]);
  });

  it('createEventMock always reports success with a mock event id, without a real Google API call', async () => {
    const result = await createEventMock({
      conversationId: 1,
      summary: 'Test',
      startISO: '2025-01-01T10:00:00',
      endISO: '2025-01-01T10:30:00',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.eventId).toMatch(/^mock-event-/);
    }
  });
});
