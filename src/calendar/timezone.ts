import { DateTime } from 'luxon';
import { getBusinessSettings } from '../config/businessSettings';

export function businessNow(): DateTime {
  return DateTime.now().setZone(getBusinessSettings().businessTimezone);
}

/** Parses a YYYY-MM-DD date + HH:mm time as a business-local DateTime. */
export function toBusinessDateTime(dateISO: string, time: string): DateTime {
  return DateTime.fromISO(`${dateISO}T${time}`, { zone: getBusinessSettings().businessTimezone });
}

/** Parses a caller-supplied ISO datetime string, assuming business timezone if no offset given. */
export function parseBusinessISO(isoString: string): DateTime {
  const withZoneGuess = DateTime.fromISO(isoString, { zone: getBusinessSettings().businessTimezone });
  return withZoneGuess;
}

export function isBusinessDay(dt: DateTime): boolean {
  return getBusinessSettings().businessDays.includes(dt.weekday);
}

export function businessHoursRangeFor(dt: DateTime): { start: DateTime; end: DateTime } {
  const settings = getBusinessSettings();
  const [startHour, startMinute] = settings.businessHoursStart.split(':').map(Number);
  const [endHour, endMinute] = settings.businessHoursEnd.split(':').map(Number);
  return {
    start: dt.set({ hour: startHour, minute: startMinute, second: 0, millisecond: 0 }),
    end: dt.set({ hour: endHour, minute: endMinute, second: 0, millisecond: 0 }),
  };
}
