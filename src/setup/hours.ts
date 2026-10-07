import { DateTime } from 'luxon';
import type { BusinessSettings } from '../config/businessSettings';

/**
 * Is the business closed right now? Only answers when opening hours were
 * actually entered for it (hoursConfigured) — otherwise it says "unknown"
 * (null) so nothing is ever claimed about hours that were never provided.
 * Days are ISO (1 = Monday … 7 = Sunday); Friday may have its own hours.
 */
export function isOutsideBusinessHours(settings: BusinessSettings, now: Date = new Date()): boolean | null {
  if (!settings.hoursConfigured) return null;
  const local = DateTime.fromJSDate(now, { zone: settings.businessTimezone });
  if (!local.isValid) return null;
  if (!settings.businessDays.includes(local.weekday)) return true;
  const friday = local.weekday === 5;
  const start = friday ? settings.fridayHoursStart ?? settings.businessHoursStart : settings.businessHoursStart;
  const end = friday ? settings.fridayHoursEnd ?? settings.businessHoursEnd : settings.businessHoursEnd;
  const minutes = local.hour * 60 + local.minute;
  const toMinutes = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  const from = toMinutes(start);
  const to = toMinutes(end);
  // A closing time at or before the opening time means "until after midnight".
  return to > from ? minutes < from || minutes >= to : minutes < from && minutes >= to;
}
