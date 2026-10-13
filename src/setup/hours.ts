import { DateTime } from 'luxon';
import type { BusinessSettings, WeeklyHours } from '../config/businessSettings';

/**
 * One business's opening hours, in its own timezone. Nothing here is ever guessed: a business whose hours were never entered
 * (hoursConfigured = false) gets `null` answers, and the callers say "hours not configured" instead of inventing them.
 *
 * Schedule sources, in order: `weeklyHours` (per-day intervals, split shifts, from migration 025) — else the older
 * start/end/days (+ Friday) columns. Whole-day `closures` (holidays) override both.
 */

export interface OpenInterval {
  start: DateTime;
  end: DateTime;
}

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** The schedule as per-day intervals ("1".."7" → [[from, to], ...]), derived from the older columns when no weekly schedule exists. */
export function effectiveWeeklyHours(settings: BusinessSettings): WeeklyHours | null {
  if (!settings.hoursConfigured) return null;
  if (settings.weeklyHours) return settings.weeklyHours; // (absent on the partial settings older callers and tests build)
  const out: WeeklyHours = {};
  for (let d = 1; d <= 7; d += 1) {
    if (!settings.businessDays.includes(d)) { out[String(d)] = []; continue; }
    const friday = d === 5;
    const start = friday ? settings.fridayHoursStart ?? settings.businessHoursStart : settings.businessHoursStart;
    const end = friday ? settings.fridayHoursEnd ?? settings.businessHoursEnd : settings.businessHoursEnd;
    out[String(d)] = [[start, end]];
  }
  return out;
}

/** True when the local calendar date is inside one of the business's closures. */
export function isClosureDay(settings: BusinessSettings, local: DateTime): boolean {
  const day = local.toISODate();
  if (!day) return false;
  return (settings.closures ?? []).some((c) => day >= c.from && day <= (c.to ?? c.from));
}

/**
 * The open intervals that START on the given local calendar day (an interval closing at or before its opening time runs past
 * midnight into the next day). Closure days have none.
 */
export function openIntervalsOn(settings: BusinessSettings, localDay: DateTime): OpenInterval[] {
  const weekly = effectiveWeeklyHours(settings);
  if (!weekly) return [];
  const day = localDay.setZone(settings.businessTimezone).startOf('day');
  if (isClosureDay(settings, day)) return [];
  const intervals = weekly[String(day.weekday)] ?? [];
  return intervals
    .map(([from, to]) => {
      const start = day.plus({ minutes: toMinutes(from) });
      const endMinutes = toMinutes(to);
      const end = endMinutes > toMinutes(from) ? day.plus({ minutes: endMinutes }) : day.plus({ days: 1, minutes: endMinutes });
      return { start, end };
    })
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());
}

/** The open interval containing the instant, or null when the business is closed at that moment (or hours are unknown). */
export function openIntervalAt(settings: BusinessSettings, at: Date): OpenInterval | null {
  if (!settings.hoursConfigured) return null;
  const local = DateTime.fromJSDate(at, { zone: settings.businessTimezone });
  if (!local.isValid) return null;
  // Yesterday's after-midnight tail counts too.
  for (const day of [local.minus({ days: 1 }), local]) {
    for (const interval of openIntervalsOn(settings, day)) {
      if (local >= interval.start && local < interval.end) return interval;
    }
  }
  return null;
}

/** Is the business open at this instant? null = hours were never configured. */
export function isOpenAt(settings: BusinessSettings, at: Date): boolean | null {
  if (!settings.hoursConfigured) return null;
  const local = DateTime.fromJSDate(at, { zone: settings.businessTimezone });
  if (!local.isValid) return null;
  return openIntervalAt(settings, at) !== null;
}

/**
 * Is the business closed right now? Only answers when opening hours were actually entered for it (hoursConfigured) —
 * otherwise it says "unknown" (null) so nothing is ever claimed about hours that were never provided.
 */
export function isOutsideBusinessHours(settings: BusinessSettings, now: Date = new Date()): boolean | null {
  const open = isOpenAt(settings, now);
  return open === null ? null : !open;
}

/** The next moment the business opens strictly after `from` (up to `horizonDays` ahead), or null when unknown / never within the horizon. */
export function nextOpening(settings: BusinessSettings, from: Date = new Date(), horizonDays = 21): DateTime | null {
  if (!settings.hoursConfigured) return null;
  const local = DateTime.fromJSDate(from, { zone: settings.businessTimezone });
  if (!local.isValid) return null;
  for (let i = 0; i <= horizonDays; i += 1) {
    const day = local.plus({ days: i }).startOf('day');
    for (const interval of openIntervalsOn(settings, day)) {
      if (interval.start > local) return interval.start;
    }
  }
  return null;
}

/** The moment the current open interval ends, or null when closed / unknown. */
export function currentClosing(settings: BusinessSettings, now: Date = new Date()): DateTime | null {
  return openIntervalAt(settings, now)?.end ?? null;
}

/** "Tomorrow at 9:00 AM" / "Saturday 18 Oct at 4:00 PM" in the customer's language, relative to `now` in the business timezone. */
export function describeMoment(settings: BusinessSettings, moment: DateTime, language: 'ar' | 'en', now: Date = new Date()): string {
  const local = moment.setZone(settings.businessTimezone);
  const today = DateTime.fromJSDate(now, { zone: settings.businessTimezone }).startOf('day');
  const dayDiff = Math.round(local.startOf('day').diff(today, 'days').days);
  const locale = language === 'ar' ? 'ar' : 'en';
  const time = local.setLocale(locale).toFormat(language === 'ar' ? 'h:mm a' : 'h:mm a');
  if (dayDiff === 0) return language === 'ar' ? `اليوم الساعة ${time}` : `today at ${time}`;
  if (dayDiff === 1) return language === 'ar' ? `غداً الساعة ${time}` : `tomorrow at ${time}`;
  const date = local.setLocale(locale).toFormat(language === 'ar' ? 'cccc d LLLL' : 'cccc d LLL');
  return language === 'ar' ? `${date} الساعة ${time}` : `${date} at ${time}`;
}
