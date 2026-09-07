import { describe, it, expect } from 'vitest';
import { toBusinessDateTime, isBusinessDay, businessHoursRangeFor } from '../../../src/calendar/timezone';

describe('timezone helpers', () => {
  it('parses date + time as a business-local datetime', () => {
    const dt = toBusinessDateTime('2025-06-10', '14:30');
    expect(dt.toFormat('yyyy-MM-dd HH:mm')).toBe('2025-06-10 14:30');
  });

  it('reports business days per configured BUSINESS_DAYS', () => {
    const monday = toBusinessDateTime('2025-06-09', '10:00'); // a Monday
    expect(isBusinessDay(monday)).toBe(true); // test setup configures all 7 days open
  });

  it('computes the configured business hours range for a given day', () => {
    const day = toBusinessDateTime('2025-06-10', '00:00');
    const { start, end } = businessHoursRangeFor(day);
    expect(start.toFormat('HH:mm')).toBe(process.env.BUSINESS_HOURS_START);
    expect(end.toFormat('HH:mm')).toBe(process.env.BUSINESS_HOURS_END);
  });
});
