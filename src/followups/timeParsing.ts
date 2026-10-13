import { DateTime } from 'luxon';
import { normalizeNumerals } from '../whatsapp/jid';

/**
 * Reads the date/time a customer typed for a callback, in the business's timezone. Accepts the forms people actually send on WhatsApp:
 *   "2026-10-20 17:30", "20/10 5:30pm", "tomorrow 10am", "today 17:00", "Sunday 11", "الأحد 11", "غداً 10 صباحاً", "10:30"
 * Returns null when nothing parseable was found; the caller re-asks (never guesses). A bare time means today, or tomorrow if it has passed.
 */

const DAY_WORDS: Record<string, number> = {
  monday: 1, mon: 1, الاثنين: 1, الإثنين: 1, اثنين: 1,
  tuesday: 2, tue: 2, tues: 2, الثلاثاء: 2, ثلاثاء: 2,
  wednesday: 3, wed: 3, الأربعاء: 3, الاربعاء: 3, اربعاء: 3, أربعاء: 3,
  thursday: 4, thu: 4, thurs: 4, الخميس: 4, خميس: 4,
  friday: 5, fri: 5, الجمعة: 5, جمعة: 5,
  saturday: 6, sat: 6, السبت: 6, سبت: 6,
  sunday: 7, sun: 7, الأحد: 7, الاحد: 7, أحد: 7, احد: 7,
};
const TODAY_WORDS = /\b(today|tonight)\b|اليوم|الليلة/i;
const TOMORROW_WORDS = /\b(tomorrow|tmrw)\b|غدا|غداً|بكرة|بكره|باكر/i;
// "5pm", "5 pm", "5p.m." — the marker may be glued to the digit, so no word boundary before it
const PM_WORDS = /(?:^|[\s\d])(pm|p\.m\.?)(?![a-z])|مساء|مساءً|العصر|عصرا|عصراً|بعد الظهر|الظهر|ظهرا|ظهراً|المغرب|العشاء/i;
const AM_WORDS = /(?:^|[\s\d])(am|a\.m\.?)(?![a-z])|صباح|صباحا|صباحاً|الصبح|الفجر/i;

export interface ParsedTime {
  at: DateTime;
  /** How the text was understood, for the confirmation ("tomorrow at 10:00 AM"). */
  assumedDate: 'explicit' | 'today' | 'tomorrow' | 'weekday' | 'next_occurrence';
}

export function parseRequestedTime(text: string, opts: { zone: string; now?: Date }): ParsedTime | null {
  const raw = normalizeNumerals(text).trim();
  if (!raw) return null;
  const now = DateTime.fromJSDate(opts.now ?? new Date(), { zone: opts.zone });
  if (!now.isValid) return null;
  const lower = raw.toLowerCase();

  // ---- time of day
  let hour: number | null = null;
  let minute = 0;
  const hm = /(\d{1,2})[:.٫](\d{2})/.exec(lower);
  if (hm) {
    hour = Number(hm[1]); minute = Number(hm[2]);
  } else {
    // a lone number after a date word / before am-pm ("tomorrow 10", "5pm", "الساعة 4")
    const lone = /(?:^|[\s,الساعة@])(\d{1,2})(?!\d)(?!\s*[/\-.]\d)/.exec(lower.replace(/(\d{4})-(\d{2})-(\d{2})/g, ' ').replace(/(\d{1,2})[/.](\d{1,2})([/.]\d{2,4})?/g, ' '));
    if (lone) hour = Number(lone[1]);
  }
  if (hour === null || hour > 23 || minute > 59) return null;
  const pm = PM_WORDS.test(lower);
  const am = AM_WORDS.test(lower);
  if (pm && hour < 12) hour += 12;
  if (am && hour === 12) hour = 0;
  // "5" with no marker in a business day is far more often 17:00 than 05:00; keep it honest: only shift clear early hours when nothing says am.
  if (!pm && !am && hour >= 1 && hour <= 6) hour += 12;

  // ---- date
  let day: DateTime | null = null;
  let assumedDate: ParsedTime['assumedDate'] = 'today';
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  const dm = /(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?/.exec(raw);
  if (iso) {
    day = DateTime.fromObject({ year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) }, { zone: opts.zone });
    assumedDate = 'explicit';
  } else if (dm && !hm?.[0].includes(dm[0])) {
    const year = dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : now.year;
    day = DateTime.fromObject({ year, month: Number(dm[2]), day: Number(dm[1]) }, { zone: opts.zone });
    if (day.isValid && !dm[3] && day < now.startOf('day')) day = day.plus({ years: 1 });
    assumedDate = 'explicit';
  } else if (TOMORROW_WORDS.test(lower)) {
    day = now.plus({ days: 1 }); assumedDate = 'tomorrow';
  } else if (TODAY_WORDS.test(lower)) {
    day = now; assumedDate = 'today';
  } else {
    const word = Object.keys(DAY_WORDS).find((w) => new RegExp(`(^|[\\s,])${w}([\\s,]|$)`, 'i').test(lower));
    if (word) {
      const target = DAY_WORDS[word]!;
      let ahead = (target - now.weekday + 7) % 7;
      if (ahead === 0 && now.hour * 60 + now.minute >= hour * 60 + minute) ahead = 7;
      day = now.plus({ days: ahead }); assumedDate = 'weekday';
    }
  }
  if (!day) { day = now; assumedDate = 'next_occurrence'; }
  if (!day.isValid) return null;
  let at = day.set({ hour, minute, second: 0, millisecond: 0 });
  if (assumedDate === 'next_occurrence' && at <= now) { at = at.plus({ days: 1 }); assumedDate = 'tomorrow'; }
  return { at, assumedDate };
}
