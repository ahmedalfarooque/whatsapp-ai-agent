import { describe, expect, it } from 'vitest';
import { parseRequestedTime } from '../../../src/followups/timeParsing';

// What customers type for a callback time, read in the business timezone (Riyadh, UTC+3). "now" = Wednesday 2026-10-07 12:00 Riyadh.
const now = new Date('2026-10-07T09:00:00Z');
const parse = (text: string) => parseRequestedTime(text, { zone: 'Asia/Riyadh', now });
const local = (text: string) => parse(text)?.at.toFormat('yyyy-MM-dd HH:mm');

describe('parseRequestedTime', () => {
  it('reads explicit dates and times, in several notations and with Arabic-Indic digits', () => {
    expect(local('2026-10-20 17:30')).toBe('2026-10-20 17:30');
    expect(local('20/10 5:30pm')).toBe('2026-10-20 17:30');
    expect(local('20/10/2026 9:00')).toBe('2026-10-20 09:00');
    expect(local('٢٠٢٦-١٠-٢٠ ١٧:٣٠')).toBe('2026-10-20 17:30');
  });
  it('understands today / tomorrow / weekday words in English and Arabic', () => {
    expect(local('tomorrow 10am')).toBe('2026-10-08 10:00');
    expect(local('today 17:00')).toBe('2026-10-07 17:00');
    expect(local('غداً 10 صباحاً')).toBe('2026-10-08 10:00');
    expect(local('الأحد 11')).toBe('2026-10-11 11:00');
    expect(local('Sunday 5pm')).toBe('2026-10-11 17:00');
    expect(parse('Sunday 5pm')?.assumedDate).toBe('weekday');
  });
  it('a bare time is today when still ahead, otherwise tomorrow; small bare hours are afternoon', () => {
    expect(local('17:30')).toBe('2026-10-07 17:30');
    expect(local('10:30')).toBe('2026-10-08 10:30'); // 10:30 has passed at noon → tomorrow
    expect(parse('10:30')?.assumedDate).toBe('tomorrow');
    expect(local('5')).toBe('2026-10-07 17:00');
  });
  it('returns null for text with no time in it, and never guesses', () => {
    for (const t of ['', 'later', 'whenever you like', 'الأحد', '99:99', 'abc 2026-13-45']) expect(parse(t), t).toBeNull();
  });
});
