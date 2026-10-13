import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { currentClosing, describeMoment, effectiveWeeklyHours, isOpenAt, isOutsideBusinessHours, nextOpening, openIntervalsOn } from '../../../src/setup/hours';
import { formatBusinessHours, formatWeeklyHours, type BusinessSettings } from '../../../src/config/businessSettings';

// Per-day schedules, split shifts, closures and "next opening" — the schedule engine behind the after-hours experience. Riyadh = UTC+3.
function settings(patch: Partial<BusinessSettings> = {}): BusinessSettings {
  return {
    hoursConfigured: true, businessTimezone: 'Asia/Riyadh', businessHoursStart: '09:00', businessHoursEnd: '18:00', businessDays: [1, 2, 3, 4, 5, 6, 7],
    fridayHoursStart: null, fridayHoursEnd: null, weeklyHours: null, closures: [], ...patch,
  } as BusinessSettings;
}
const at = (iso: string): Date => new Date(iso);
// 2026-10-07 = Wednesday, 2026-10-08 = Thursday, 2026-10-09 = Friday, 2026-10-10 = Saturday
const SPLIT: BusinessSettings['weeklyHours'] = { '1': [['09:00', '13:00'], ['16:00', '21:00']], '2': [['09:00', '13:00'], ['16:00', '21:00']], '3': [['09:00', '13:00'], ['16:00', '21:00']], '4': [['09:00', '13:00']], '5': [], '6': [['16:00', '23:00']], '7': [['09:00', '13:00'], ['16:00', '21:00']] };

describe('the simple columns become a weekly schedule', () => {
  it('derives one interval per business day (Friday with its own hours) and an empty list for closed days', () => {
    const weekly = effectiveWeeklyHours(settings({ businessDays: [1, 2, 3, 4, 6], fridayHoursStart: '16:00', fridayHoursEnd: '20:00' }))!;
    expect(weekly['1']).toEqual([['09:00', '18:00']]);
    expect(weekly['5']).toEqual([]); // Friday is not a business day here, whatever its hours say
    expect(weekly['7']).toEqual([]);
    expect(effectiveWeeklyHours(settings({ hoursConfigured: false }))).toBeNull();
  });
});

describe('split shifts and per-day hours', () => {
  const s = settings({ weeklyHours: SPLIT });
  it('is open inside either shift and closed in the gap, on a closed weekday, and before/after', () => {
    expect(isOpenAt(s, at('2026-10-07T07:00:00Z'))).toBe(true); // Wed 10:00
    expect(isOpenAt(s, at('2026-10-07T11:30:00Z'))).toBe(false); // Wed 14:30 — between shifts
    expect(isOpenAt(s, at('2026-10-07T15:00:00Z'))).toBe(true); // Wed 18:00
    expect(isOpenAt(s, at('2026-10-07T18:30:00Z'))).toBe(false); // Wed 21:30
    expect(isOpenAt(s, at('2026-10-09T08:00:00Z'))).toBe(false); // Friday closed
    expect(isOpenAt(s, at('2026-10-10T15:00:00Z'))).toBe(true); // Saturday evening only
    expect(isOutsideBusinessHours(s, at('2026-10-07T11:30:00Z'))).toBe(true);
  });
  it('knows the next opening across the gap, the next day and a closed day', () => {
    expect(nextOpening(s, at('2026-10-07T11:30:00Z'))!.toISO()).toBe(DateTime.fromISO('2026-10-07T16:00:00', { zone: 'Asia/Riyadh' }).toISO()); // Wed gap → 16:00
    expect(nextOpening(s, at('2026-10-08T11:00:00Z'))!.toISO()).toBe(DateTime.fromISO('2026-10-10T16:00:00', { zone: 'Asia/Riyadh' }).toISO()); // Thu 14:00 → Sat 16:00 (Fri closed)
    expect(currentClosing(s, at('2026-10-07T07:00:00Z'))!.toISO()).toBe(DateTime.fromISO('2026-10-07T13:00:00', { zone: 'Asia/Riyadh' }).toISO());
    expect(currentClosing(s, at('2026-10-07T11:30:00Z'))).toBeNull();
  });
  it('renders every day in Saudi week order with both shifts, and the closed days', () => {
    const text = formatWeeklyHours(SPLIT, 'en');
    expect(text.split('\n')[0]).toBe('• Saturday: 4:00 PM - 11:00 PM');
    expect(text).toContain('• Monday: 9:00 AM - 1:00 PM / 4:00 PM - 9:00 PM');
    expect(text).toContain('• Closed: Friday');
    expect(formatBusinessHours(s, 'ar')).toContain('مغلق');
  });
});

describe('closures and past-midnight hours', () => {
  it('a holiday closes the whole day (and a range every day in it); the next opening skips it', () => {
    const s = settings({ closures: [{ from: '2026-10-07', label: 'Holiday' }, { from: '2026-10-12', to: '2026-10-13' }] });
    expect(isOpenAt(s, at('2026-10-07T08:00:00Z'))).toBe(false);
    expect(isOpenAt(s, at('2026-10-08T08:00:00Z'))).toBe(true);
    expect(isOpenAt(s, at('2026-10-13T08:00:00Z'))).toBe(false);
    expect(nextOpening(s, at('2026-10-07T08:00:00Z'))!.toISO()).toBe(DateTime.fromISO('2026-10-08T09:00:00', { zone: 'Asia/Riyadh' }).toISO());
    expect(openIntervalsOn(s, DateTime.fromISO('2026-10-07', { zone: 'Asia/Riyadh' }))).toEqual([]);
  });
  it('an interval closing after midnight stays open into the next day', () => {
    const s = settings({ weeklyHours: { '1': [['18:00', '02:00']], '2': [['18:00', '02:00']], '3': [['18:00', '02:00']], '4': [], '5': [], '6': [], '7': [] } });
    expect(isOpenAt(s, at('2026-10-07T22:00:00Z'))).toBe(true); // Thu 01:00 Riyadh, Wednesday's tail
    expect(isOpenAt(s, at('2026-10-08T00:00:00Z'))).toBe(false); // Thu 03:00
    expect(nextOpening(s, at('2026-10-08T00:00:00Z'))!.toISO()).toBe(DateTime.fromISO('2026-10-12T18:00:00', { zone: 'Asia/Riyadh' }).toISO()); // Thu–Sun closed → Monday 18:00
  });
  it('never claims anything when hours were not configured', () => {
    const s = settings({ hoursConfigured: false });
    expect(isOpenAt(s, at('2026-10-07T08:00:00Z'))).toBeNull();
    expect(nextOpening(s, at('2026-10-07T08:00:00Z'))).toBeNull();
    expect(isOutsideBusinessHours(s)).toBeNull();
  });
});

describe('describeMoment', () => {
  const s = settings();
  it('says today / tomorrow / the weekday with the local time, in both languages', () => {
    const now = at('2026-10-07T06:00:00Z'); // Wed 09:00 Riyadh
    expect(describeMoment(s, DateTime.fromISO('2026-10-07T16:00:00', { zone: 'Asia/Riyadh' }), 'en', now)).toBe('today at 4:00 PM');
    expect(describeMoment(s, DateTime.fromISO('2026-10-08T09:00:00', { zone: 'Asia/Riyadh' }), 'en', now)).toBe('tomorrow at 9:00 AM');
    expect(describeMoment(s, DateTime.fromISO('2026-10-10T16:00:00', { zone: 'Asia/Riyadh' }), 'en', now)).toBe('Saturday 10 Oct at 4:00 PM');
    expect(describeMoment(s, DateTime.fromISO('2026-10-08T09:00:00', { zone: 'Asia/Riyadh' }), 'ar', now)).toMatch(/^غداً الساعة /);
  });
});
