/**
 * Shared reply-language policy for EVERY business (existing and future).
 *
 * The language a customer chose from the menu (customers.language, 'ar' | 'en') decides which menu/template texts they get. It is NOT
 * the language the assistant must write in: the assistant answers in the language of the customer's LATEST message, so a customer who
 * picked "English" from the menu and then writes in Malayalam gets Malayalam, and one who switches mid-conversation is followed. A
 * business may override this deliberately (business_settings.ai_reply_language = a code); nothing else locks a conversation to one language.
 *
 * Detection is script-based and dependency-free: it works for every Unicode script, never calls a model, and only names a language the
 * text itself shows. Latin-script text is told apart by the most common function words of a few languages; anything else in Latin script
 * is reported as English. "Unknown" (numbers, emoji, a bare code) means: keep the language the conversation was already in.
 */

export interface DetectedLanguage {
  /** ISO 639-1 code (or 'zh' for any Han text). */
  code: string;
  /** English name, as given to the model. */
  name: string;
  /** How sure the detector is; 'low' for very short Latin text. */
  confidence: 'high' | 'medium' | 'low';
}

const SCRIPTS: Array<{ code: string; name: string; re: RegExp }> = [
  { code: 'ar', name: 'Arabic', re: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g },
  { code: 'ml', name: 'Malayalam', re: /[\u0D00-\u0D7F]/g },
  { code: 'ta', name: 'Tamil', re: /[\u0B80-\u0BFF]/g },
  { code: 'te', name: 'Telugu', re: /[\u0C00-\u0C7F]/g },
  { code: 'kn', name: 'Kannada', re: /[\u0C80-\u0CFF]/g },
  { code: 'hi', name: 'Hindi', re: /[\u0900-\u097F]/g },
  { code: 'bn', name: 'Bengali', re: /[\u0980-\u09FF]/g },
  { code: 'gu', name: 'Gujarati', re: /[\u0A80-\u0AFF]/g },
  { code: 'pa', name: 'Punjabi', re: /[\u0A00-\u0A7F]/g },
  { code: 'si', name: 'Sinhala', re: /[\u0D80-\u0DFF]/g },
  { code: 'th', name: 'Thai', re: /[\u0E00-\u0E7F]/g },
  { code: 'ja', name: 'Japanese', re: /[\u3040-\u30FF]/g },
  { code: 'ko', name: 'Korean', re: /[\uAC00-\uD7AF\u1100-\u11FF]/g },
  { code: 'zh', name: 'Chinese', re: /[\u4E00-\u9FFF\u3400-\u4DBF]/g },
  { code: 'ru', name: 'Russian', re: /[\u0400-\u04FF]/g },
  { code: 'el', name: 'Greek', re: /[\u0370-\u03FF]/g },
  { code: 'he', name: 'Hebrew', re: /[\u0590-\u05FF]/g },
  { code: 'am', name: 'Amharic', re: /[\u1200-\u137F]/g },
];

/** Very common function words; a Latin-script message is attributed to the language with the most hits (ties and no hits: English). */
const LATIN_MARKERS: Array<{ code: string; name: string; words: string[]; chars?: RegExp }> = [
  { code: 'fr', name: 'French', words: ['le', 'la', 'les', 'des', 'une', 'est', 'et', 'vous', 'je', 'pour', 'avec', 'bonjour', 'merci', 'quel', 'quelle', 'combien', 'prix', 'avez', 'votre', 'nous', 'sur', 'dans', 'pas', 'que', 'qui'], chars: /[àâçéèêëîïôûùüÿœ]/i },
  { code: 'es', name: 'Spanish', words: ['el', 'los', 'las', 'una', 'es', 'y', 'usted', 'para', 'con', 'hola', 'gracias', 'cuál', 'cuánto', 'precio', 'tienen', 'quiero', 'por', 'qué', 'como', 'más'], chars: /[ñ¿¡áéíóú]/i },
  { code: 'de', name: 'German', words: ['der', 'die', 'das', 'und', 'ist', 'ich', 'sie', 'nicht', 'mit', 'hallo', 'danke', 'wie', 'viel', 'preis', 'haben', 'für', 'ein', 'eine', 'bitte'], chars: /[äöüß]/i },
  { code: 'pt', name: 'Portuguese', words: ['o', 'os', 'as', 'uma', 'é', 'e', 'você', 'para', 'com', 'olá', 'obrigado', 'obrigada', 'qual', 'quanto', 'preço', 'têm', 'não', 'por', 'que', 'bom'], chars: /[ãõç]/i },
  { code: 'it', name: 'Italian', words: ['il', 'lo', 'gli', 'una', 'è', 'e', 'lei', 'per', 'con', 'ciao', 'grazie', 'quale', 'quanto', 'prezzo', 'avete', 'vorrei', 'non', 'che', 'del', 'della'] },
  { code: 'id', name: 'Indonesian', words: ['yang', 'dan', 'untuk', 'dengan', 'saya', 'anda', 'berapa', 'harga', 'apakah', 'ada', 'ini', 'itu', 'tidak', 'bisa', 'mau', 'terima', 'kasih', 'selamat'] },
  { code: 'tr', name: 'Turkish', words: ['ve', 'bir', 'bu', 'için', 'ile', 'merhaba', 'teşekkür', 'fiyat', 'ne', 'kadar', 'var', 'mı', 'mi', 'nasıl', 'ben', 'siz'], chars: /[çğışöü]/i },
  { code: 'tl', name: 'Filipino', words: ['ang', 'ng', 'mga', 'sa', 'ako', 'ikaw', 'po', 'magkano', 'kayo', 'salamat', 'kumusta', 'ba', 'ito', 'yan', 'meron', 'wala'] },
  { code: 'ms', name: 'Malay', words: ['saya', 'awak', 'anda', 'berapa', 'harga', 'ada', 'boleh', 'nak', 'tak', 'terima', 'kasih', 'untuk', 'dengan', 'ini', 'itu', 'macam', 'mana'] },
  { code: 'sw', name: 'Swahili', words: ['na', 'ni', 'ya', 'wa', 'kwa', 'habari', 'asante', 'bei', 'gani', 'nina', 'unaweza', 'tafadhali', 'sawa', 'hii', 'hapa'] },
];
const ENGLISH_WORDS = new Set(['the', 'and', 'is', 'are', 'you', 'do', 'does', 'how', 'much', 'price', 'have', 'can', 'what', 'for', 'with', 'this', 'that', 'please', 'thanks', 'hello', 'hi', 'want', 'need', 'my', 'me', 'it', 'of', 'to', 'in', 'on', 'your', 'i']);

/** Letters only (every script), so identifiers, numbers, punctuation and emoji never decide a language. */
function lettersOf(text: string): string {
  return text.replace(/[\d\s\p{P}\p{S}]/gu, '');
}

/**
 * The language the customer's message is written in, or null when the text shows none (empty, numbers, codes, emoji).
 * Mixed scripts: the script with the most letters wins (a Malayalam question that names "Toyota Camry" is Malayalam; an Arabic message
 * with a Latin brand name is Arabic). Latin text with a few words is attributed by function words, English by default.
 */
export function detectMessageLanguage(text: string | null | undefined): DetectedLanguage | null {
  if (!text) return null;
  const letters = lettersOf(text);
  if (!letters) return null;
  let best: { code: string; name: string; count: number } | null = null;
  for (const s of SCRIPTS) {
    const count = (letters.match(s.re) ?? []).length;
    if (count > 0 && (!best || count > best.count)) best = { code: s.code, name: s.name, count };
  }
  const latin = (letters.match(/[A-Za-zÀ-ɏ]/g) ?? []).length;
  if (best && best.count >= latin) {
    // Japanese text also contains Han characters: kana decides.
    return { code: best.code, name: best.name, confidence: best.count >= 3 ? 'high' : 'medium' };
  }
  if (latin === 0) return null;
  const words = text.toLowerCase().normalize('NFC').split(/[^\p{L}\p{M}'’]+/u).filter(Boolean);
  let top: { code: string; name: string; score: number } = { code: 'en', name: 'English', score: 0 };
  let english = 0;
  for (const w of words) if (ENGLISH_WORDS.has(w)) english += 1;
  for (const m of LATIN_MARKERS) {
    let score = 0;
    for (const w of words) if (m.words.includes(w)) score += 1;
    if (m.chars && m.chars.test(text)) score += 2;
    if (score > top.score) top = { code: m.code, name: m.name, score };
  }
  if (top.score === 0 || english >= top.score) return { code: 'en', name: 'English', confidence: words.length >= 3 ? (english > 0 ? 'high' : 'medium') : 'low' };
  return { code: top.code, name: top.name, confidence: top.score >= 2 ? 'high' : 'medium' };
}

const CODE_NAMES: Record<string, string> = Object.fromEntries([
  ...SCRIPTS.map((s) => [s.code, s.name]),
  ...LATIN_MARKERS.map((m) => [m.code, m.name]),
  ['en', 'English'], ['ur', 'Urdu'], ['fa', 'Persian'], ['nl', 'Dutch'], ['pl', 'Polish'], ['sv', 'Swedish'], ['vi', 'Vietnamese'],
]);

/** "Arabic" for 'ar'; the code itself for one the table does not name (the model understands ISO codes). */
export function languageName(code: string): string {
  return CODE_NAMES[code.toLowerCase().split('-')[0]!] ?? code;
}

export interface ReplyLanguageInput {
  /** The customer's latest message (text or the caption under a picture). */
  latestText?: string | null;
  /** The language the customer picked from the menu ('ar' | 'en'), used for templates. */
  menuLanguage?: string | null;
  /** business_settings.ai_reply_language: a deliberate per-business override, or null for the shared policy. */
  accountOverride?: string | null;
}

export interface ReplyLanguageDecision {
  /** The language the assistant is asked to write in, or null when the model should follow the latest message itself. */
  code: string | null;
  name: string | null;
  source: 'account_override' | 'latest_message' | 'menu_choice' | 'unknown';
  /** The exact instruction given to the model. */
  instruction: string;
}

/** The shared decision every business uses; see the file header. Pure, so it is unit-tested and never differs between accounts. */
export function decideReplyLanguage(input: ReplyLanguageInput): ReplyLanguageDecision {
  const override = input.accountOverride?.trim();
  if (override) {
    const name = languageName(override);
    return { code: override, name, source: 'account_override', instruction: `REPLY LANGUAGE: ${name}. This business always replies in ${name} (a deliberate business setting), whatever language the customer writes in. Keep brand, product, model and place names and any codes or numbers exactly as written.` };
  }
  const detected = detectMessageLanguage(input.latestText);
  if (detected && detected.confidence !== 'low') {
    return {
      code: detected.code, name: detected.name, source: 'latest_message',
      instruction: `REPLY LANGUAGE: ${detected.name}. The customer's latest message is written in ${detected.name}, so write this reply in natural, correct ${detected.name}${detected.code === 'ar' ? ' (right-to-left script; no transliteration into Latin letters)' : ''}. ${LANGUAGE_RULES}`,
    };
  }
  if (input.menuLanguage) {
    const name = languageName(input.menuLanguage);
    return {
      code: input.menuLanguage, name, source: 'menu_choice',
      instruction: `REPLY LANGUAGE: ${name} for this message (the customer chose ${name} from the menu and their latest message shows no particular language). ${LANGUAGE_RULES}`,
    };
  }
  return { code: null, name: null, source: 'unknown', instruction: `REPLY LANGUAGE: the language of the customer's latest message. ${LANGUAGE_RULES}` };
}

const LANGUAGE_RULES = 'Always answer in the language the customer used in their LATEST message: if they switch language, switch with them, every time; if a message mixes languages, use the main language of the question itself; if they explicitly ask for a language, use it. The language chosen from the menu only selects the menu texts, never the reply language. Keep brand, product, model and place names, product codes, part numbers, phone numbers and addresses exactly as written (never translated or altered); numbers stay numbers.';
