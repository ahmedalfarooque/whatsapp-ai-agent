import { describe, it, expect } from 'vitest';
import { computeFreeSlots } from '../../../src/calendar/availability';

describe('computeFreeSlots', () => {
  it('slices business hours into duration-sized free slots when nothing is busy', () => {
    // Test business hours (tests/setup.ts) 00:00-23:59, 30 min slots => 47 slots (the 23:30 slot would end at 24:00, after closing), minus past-time filtering.
    const farFutureDate = '2999-06-10'; // ensures no slot is filtered as "past"
    const slots = computeFreeSlots(farFutureDate, 30, [], 0);
    expect(slots.length).toBe(47);
    expect(slots[0].toFormat('HH:mm')).toBe('00:00');
    expect(slots[slots.length - 1].toFormat('HH:mm')).toBe('23:00');
  });

  it('excludes slots that overlap a busy interval', () => {
    const farFutureDate = '2999-06-10';
    const busy = [{ start: '2999-06-10T10:00:00.000Z', end: '2999-06-10T11:00:00.000Z' }];
    const slots = computeFreeSlots(farFutureDate, 30, busy, 0);
    const overlapping = slots.filter((s) => s.toFormat('HH:mm') === '10:00' || s.toFormat('HH:mm') === '10:30');
    expect(overlapping).toHaveLength(0);
  });

  it('applies a buffer around busy intervals', () => {
    const farFutureDate = '2999-06-10';
    const busy = [{ start: '2999-06-10T10:00:00.000Z', end: '2999-06-10T10:30:00.000Z' }];
    const withoutBuffer = computeFreeSlots(farFutureDate, 30, busy, 0);
    const withBuffer = computeFreeSlots(farFutureDate, 30, busy, 30);
    expect(withBuffer.length).toBeLessThan(withoutBuffer.length);
  });

  it('never returns a slot in the past for today', () => {
    const today = new Date().toISOString().slice(0, 10);
    const slots = computeFreeSlots(today, 30, [], 0);
    const now = new Date();
    for (const slot of slots) {
      expect(slot.toJSDate().getTime()).toBeGreaterThan(now.getTime() - 60_000);
    }
  });
});
