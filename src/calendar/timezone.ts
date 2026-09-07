import { DateTime } from 'luxon';
import { env } from '../config/env';

export function businessNow(): DateTime {
  return DateTime.now().setZone(env.BUSINESS_TIMEZONE);
}

/** Parses a YYYY-MM-DD date + HH:mm time as a business-local DateTime. */
export function toBusinessDateTime(dateISO: string, time: string): DateTime {
  return DateTime.fromISO(`${dateISO}T${time}`, { zone: env.BUSINESS_TIMEZONE });
}

/** Parses a caller-supplied ISO datetime string, assuming business timezone if no offset given. */
export function parseBusinessISO(isoString: string): DateTime {
  const withZoneGuess = DateTime.fromISO(isoString, { zone: env.BUSINESS_TIMEZONE });
  return withZoneGuess;
}

export function isBusinessDay(dt: DateTime): boolean {
  return env.BUSINESS_DAYS.includes(dt.weekday);
}

export function businessHoursRangeFor(dt: DateTime): { start: DateTime; end: DateTime } {
  const [startHour, startMinute] = env.BUSINESS_HOURS_START.split(':').map(Number);
  const [endHour, endMinute] = env.BUSINESS_HOURS_END.split(':').map(Number);
  return {
    start: dt.set({ hour: startHour, minute: startMinute, second: 0, millisecond: 0 }),
    end: dt.set({ hour: endHour, minute: endMinute, second: 0, millisecond: 0 }),
  };
}
