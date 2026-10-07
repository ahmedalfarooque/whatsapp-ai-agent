import { describe, expect, it } from 'vitest';
import { isOutsideBusinessHours } from '../../../src/setup/hours';
import type { BusinessSettings } from '../../../src/config/businessSettings';

function settings(patch: Partial<BusinessSettings> = {}): BusinessSettings {
  return {
    hoursConfigured: true, businessTimezone: 'Asia/Riyadh', businessHoursStart: '10:00', businessHoursEnd: '22:00', businessDays: [1, 2, 3, 4, 5, 6, 7],
    fridayHoursStart: '16:00', fridayHoursEnd: '22:00', ...patch,
  } as BusinessSettings;
}
// 2026-10-07 is a Wednesday; Riyadh is UTC+3.
const at = (iso: string): Date => new Date(iso);

describe('isOutsideBusinessHours', () => {
  it('says "unknown" (null) when no hours were ever entered — it never claims anything', () => {
    expect(isOutsideBusinessHours(settings({ hoursConfigured: false }), at('2026-10-07T01:00:00Z'))).toBeNull();
  });
  it('is inside during opening hours and outside before/after, in the business time zone', () => {
    expect(isOutsideBusinessHours(settings(), at('2026-10-07T09:00:00Z'))).toBe(false); // 12:00 Riyadh
    expect(isOutsideBusinessHours(settings(), at('2026-10-07T05:00:00Z'))).toBe(true); // 08:00
    expect(isOutsideBusinessHours(settings(), at('2026-10-07T19:30:00Z'))).toBe(true); // 22:30
    expect(isOutsideBusinessHours(settings(), at('2026-10-07T18:59:00Z'))).toBe(false); // 21:59
  });
  it('closed days and Friday-specific hours', () => {
    expect(isOutsideBusinessHours(settings({ businessDays: [1, 2, 3, 4, 6, 7] }), at('2026-10-09T09:00:00Z'))).toBe(true); // Friday not a business day
    expect(isOutsideBusinessHours(settings(), at('2026-10-09T09:00:00Z'))).toBe(true); // Friday 12:00 < 16:00
    expect(isOutsideBusinessHours(settings(), at('2026-10-09T14:00:00Z'))).toBe(false); // Friday 17:00
  });
  it('hours that run past midnight', () => {
    const late = settings({ businessHoursStart: '18:00', businessHoursEnd: '02:00' });
    expect(isOutsideBusinessHours(late, at('2026-10-07T21:00:00Z'))).toBe(false); // 00:00
    expect(isOutsideBusinessHours(late, at('2026-10-07T10:00:00Z'))).toBe(true); // 13:00
  });
});
