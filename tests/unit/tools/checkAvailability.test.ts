import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DateTime } from 'luxon';

vi.mock('../../../src/calendar/availability', () => ({
  findFreeSlots: vi.fn(),
}));

import { findFreeSlots } from '../../../src/calendar/availability';
import { checkAvailabilityHandler } from '../../../src/tools/checkAvailability';

describe('checkAvailabilityHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns real slots from the calendar integration', async () => {
    const slot = DateTime.fromISO('2025-06-10T10:00:00', { zone: 'UTC' });
    vi.mocked(findFreeSlots).mockResolvedValue([slot]);

    const result = await checkAvailabilityHandler({ date: '2025-06-10', durationMinutes: 30 }, { conversationId: 1 });

    expect(findFreeSlots).toHaveBeenCalledWith('2025-06-10', 30);
    expect(result.error).toBeUndefined();
    expect(result.slots).toHaveLength(1);
  });

  it('returns an empty slot list (never fabricated) when the calendar has none free', async () => {
    vi.mocked(findFreeSlots).mockResolvedValue([]);
    const result = await checkAvailabilityHandler({ date: '2025-06-10', durationMinutes: 30 }, { conversationId: 1 });
    expect(result.slots).toEqual([]);
  });

  it('rejects invalid arguments without calling the calendar', async () => {
    const result = await checkAvailabilityHandler({ date: 'not-a-date', durationMinutes: 30 }, { conversationId: 1 });
    expect(result.error).toBeDefined();
    expect(findFreeSlots).not.toHaveBeenCalled();
  });

  it('reports a tool error (not a crash) when the calendar integration throws', async () => {
    vi.mocked(findFreeSlots).mockRejectedValue(new Error('Google API down'));
    const result = await checkAvailabilityHandler({ date: '2025-06-10', durationMinutes: 30 }, { conversationId: 1 });
    expect(result.error).toBe('availability_check_failed');
    expect(result.slots).toEqual([]);
  });
});
