import type { CustomerLanguage } from '../memory/customerRepo';
import { resolveTemplate } from '../templates/templateRepo';
import { GOOGLE_MAPS_LINK } from '../templates/defaults';
import { normalizeNumerals } from '../whatsapp/jid';

export { GOOGLE_MAPS_LINK };

// Keyword helpers shared by the guided-menu router (menuRouter.ts) and the
// pipeline. All customer-facing TEXT lives in the reply templates; this file
// only knows which words trigger which navigation.

const HUMAN_SUPPORT_KEYWORDS = [
  'agent', 'human', 'support', 'staff', 'manager', 'complaint', 'customer service', 'talk to someone', 'talk to human',
  'موظف', 'مدير', 'المدير', 'خدمة العملاء', 'شكوى', 'أريد التحدث مع شخص', 'تحدث مع موظف', 'انسان', 'إنسان',
];

/** True when the customer asks for a person — automation pauses and the support queue gets an entry. */
export function isHumanSupportRequest(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = normalize(text);
  return HUMAN_SUPPORT_KEYWORDS.some((k) => normalized === k);
}

/**
 * Stable IDs still accepted from the legacy Meta Cloud API button/list
 * replies. The QR (linked-device) channel never sends these — customers
 * type the option number and the router maps it by menu state.
 */
export const MENU_IDS = {
  LANG_EN: 'lang_en',
  LANG_AR: 'lang_ar',
  CATEGORY_AUDIO: 'menu_car_audio',
  CATEGORY_ACCESSORIES: 'menu_car_accessories',
  CATEGORY_CARE: 'menu_car_care',
  PRICES: 'menu_prices',
  LOCATION: 'menu_location',
  MAIN_MENU: 'menu_main',
  CHANGE_LANGUAGE: 'menu_change_language',
} as const;

export type MenuId = (typeof MENU_IDS)[keyof typeof MENU_IDS];

const MENU_KEYWORDS = ['menu', 'main menu', 'services', 'back', 'القائمة', 'قائمة', 'الرئيسية', 'الخدمات', 'رجوع'];

const CHANGE_LANGUAGE_KEYWORDS = ['change language', 'language', 'تغيير اللغة', 'اللغة'];

/** Greetings re-open the main menu once a language is known (same as the original Antigravity router). */
const GREETINGS = [
  'hi', 'hello', 'hey', 'start', 'مرحبا', 'مرحباً', 'السلام عليكم', 'سلام', 'اهلا', 'أهلا', 'أهلاً', 'اهلين', 'هلا',
];

const LANGUAGE_KEYWORDS: { language: CustomerLanguage; keywords: string[] }[] = [
  { language: 'en', keywords: ['english', 'en', 'الإنجليزية', 'انجليزي', 'إنجليزي'] },
  { language: 'ar', keywords: ['arabic', 'ar', 'عربي', 'العربية', 'عربى'] },
];

function normalize(text: string): string {
  return normalizeNumerals(text).trim().toLowerCase().replace(/[.!؟?]+$/, '');
}

/** Detects a bare language-name reply typed as free text. */
export function detectLanguageFromText(text: string | undefined): CustomerLanguage | undefined {
  if (!text) return undefined;
  const normalized = normalize(text);
  return LANGUAGE_KEYWORDS.find((entry) => entry.keywords.includes(normalized))?.language;
}

/** True when the free-text message is a request to see the menu again ("menu", "0", "back", "القائمة"…). */
export function isMenuKeyword(text: string | undefined, _language?: CustomerLanguage): boolean {
  if (!text) return false;
  const normalized = normalize(text);
  return normalized === '0' || MENU_KEYWORDS.includes(normalized);
}

/** True when the free-text message is a request to change the conversation language. */
export function isChangeLanguageKeyword(text: string | undefined, _language?: CustomerLanguage): boolean {
  if (!text) return false;
  return CHANGE_LANGUAGE_KEYWORDS.includes(normalize(text));
}

export function isGreeting(text: string | undefined): boolean {
  if (!text) return false;
  return GREETINGS.includes(normalize(text));
}

/** "00" is the original router's hard restart; kept alongside the configured restart keywords. */
export function isHardRestart(text: string | undefined): boolean {
  if (!text) return false;
  return normalize(text) === '00';
}

export function buildHumanSupportMessage(language: CustomerLanguage): string {
  return resolveTemplate('human_support', language);
}
