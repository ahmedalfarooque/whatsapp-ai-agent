import { isHumanSupportRequest } from '../automation/menu';
import { normalizeNumerals } from '../whatsapp/jid';

/**
 * Does this customer message ask for a real person? One pure, testable decision — no database, no network.
 *
 *  - 'exact'  the whole message is one of the established keywords (agent, human, موظف, خدمة العملاء …) — the original behaviour, unchanged.
 *  - 'high'   a clear request in a sentence ("I need a real person", "أبغى أكلم شخص", "connect me to an agent"), understood from the
 *             words around it rather than a fixed phrase list: a request cue (speak / want / connect …) close to a person noun, with
 *             negations ("I don't want to talk to a human"), third parties ("he wants a manager"), thanks, jobs and look-alike nouns
 *             ("real estate agent", "contact person", "someone to manage my property") ruled out.
 *  - 'none'   not a request. Anything unclear stays with the assistant, which can still hand over through its own tool.
 *
 * Inside a guided request flow (collecting a name, a date, notes …) only 'exact' counts, so a sentence typed as an answer is never
 * taken for a request to leave the flow.
 */
export interface HumanHandoffIntent {
  requested: boolean;
  confidence: 'exact' | 'high' | 'none';
  /** Which rule fired — for logs and tests, never shown to the customer. */
  rule: string | null;
}

const NONE: HumanHandoffIntent = { requested: false, confidence: 'none', rule: null };

// ---------------------------------------------------------------- normalisation

/** Lower-case, Latin and Arabic letters only, Arabic spelling variants unified, no diacritics/tatweel/punctuation. */
export function normalizeIntentText(text: string): string {
  return normalizeNumerals(text)
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '') // tashkeel, dagger alef, tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/['’`´]/g, '') // don't → dont
    .replace(/[^a-z0-9ء-ي\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EXACT = new Set([
  'human', 'a human', 'real person', 'a real person', 'live agent', 'human agent', 'agent please', 'human please', 'person please',
  'representative', 'customer service', 'customer support', 'customer care',
  'موظف', 'موظفه', 'خدمه العملاء', 'انسان', 'شخص حقيقي', 'بشري',
]);

// ---------------------------------------------------------------- English

const EN_TALK = new Set(['speak', 'talk', 'chat', 'connect', 'transfer', 'put', 'forward', 'escalate', 'redirect', 'hand', 'switch', 'speaking', 'talking', 'connecting', 'transferring']);
const EN_WANT = new Set(['want', 'need', 'wish', 'prefer', 'require', 'needs', 'wants']);
const EN_PREP = new Set(['to', 'with', 'through', 'over']);
const EN_STRONG = new Set(['human', 'humans', 'person', 'representative', 'rep', 'operator']);
const EN_WEAK = new Set(['someone', 'somebody', 'agent', 'staff', 'manager', 'supervisor', 'team', 'employee']);
const EN_NEG = new Set(['dont', 'not', 'no', 'never', 'wont', 'cant', 'cannot', 'without', 'neither', 'nor']);
const EN_THIRD = new Set(['he', 'she', 'they', 'him', 'her', 'them', 'who', 'which', 'customer', 'customers', 'client', 'clients', 'people']);
const EN_BLOCK = new Set(['thank', 'thanks', 'praise', 'compliment', 'appreciate', 'review', 'rate', 'hire', 'hiring', 'job', 'jobs', 'apply', 'application', 'vacancy', 'career', 'recruit', 'interview', 'salary', 'resume', 'cv']);
const EN_HELP_VERBS = new Set(['help', 'assist', 'talk', 'speak', 'answer', 'reply', 'respond', 'explain', 'call', 'contact', 'chat', 'guide', 'advise', 'listen', 'support', 'handle', 'get']);
const EN_LOOKALIKE_BEFORE = new Set(['estate', 'insurance', 'travel', 'property', 'rental', 'letting', 'booking', 'ticket', 'shipping', 'ai', 'contact', 'third', 'sales']);

function enNounAt(tokens: string[], i: number): 'strong' | 'weak' | null {
  const t = tokens[i]!;
  const prev = tokens[i - 1] ?? '';
  if (t === 'customer' && /^(service|support|care)$/.test(tokens[i + 1] ?? '')) return 'strong';
  if (t === 'support' && /^(team|agent|staff|person)$/.test(tokens[i + 1] ?? '')) return 'strong';
  if (t === 'live' && /^(agent|person|chat)$/.test(tokens[i + 1] ?? '')) return 'strong';
  if (t === 'agent' && (prev === 'human' || prev === 'live' || prev === 'real')) return 'strong';
  if (EN_LOOKALIKE_BEFORE.has(prev) && (t === 'agent' || t === 'person' || t === 'manager' || t === 'team')) return null;
  if (t === 'someone' || t === 'somebody') return /^(else|in|from|at|who)$/.test(tokens[i + 1] ?? '') ? null : 'weak';
  // "a person to value the building" asks for a service; "a person to help me" asks for someone to talk to.
  if ((t === 'person' || t === 'human') && tokens[i + 1] === 'to' && tokens[i + 2] && !EN_HELP_VERBS.has(tokens[i + 2]!)) return null;
  if (EN_STRONG.has(t)) return 'strong';
  if (EN_WEAK.has(t)) return 'weak';
  return null;
}

function englishRule(tokens: string[]): string | null {
  const hasBlock = tokens.some((t) => EN_BLOCK.has(t));
  const n = tokens.length;
  // "I don't want to talk to a robot" — the one case where a negation IS the request.
  if (/\b(?:dont|do not|no|not|stop|tired of|sick of)\b(?: want)?(?: to)? (?:talk|talking|speak|speaking|chat|chatting|deal|dealing) (?:to|with) (?:a |an |the |this )?(?:bot|robot|chatbot|ai|machine)\b/.test(tokens.join(' '))) return 'en:not-a-bot';

  if (/\bis there (?:a |an |any )?(?:real |live |human |actual )(?:person|human|agent|representative)\b/.test(tokens.join(' '))) return 'en:is-there';

  for (let i = 0; i < n; i += 1) {
    const t = tokens[i]!;
    const before = tokens.slice(Math.max(0, i - 3), i);
    const before2 = tokens.slice(Math.max(0, i - 4), i);
    if (before.some((w) => EN_NEG.has(w)) || before2.some((w) => EN_THIRD.has(w))) continue;
    const window = tokens.slice(i + 1, i + 8);

    const isTalk = EN_TALK.has(t);
    const isWant = EN_WANT.has(t) || (t === 'like' && /^(would|id|wed|youd)$/.test(tokens[i - 1] ?? ''));
    const isGet = (t === 'get' || t === 'have' || t === 'give') && (/^(me|us)$/.test(tokens[i + 1] ?? '') || before.some((w) => /^(can|could|may|possible|able|please)$/.test(w)));
    if (!isTalk && !isWant && !isGet) continue;
    if (hasBlock && window.some((w) => EN_BLOCK.has(w))) continue;

    for (let j = 0; j < window.length; j += 1) {
      const kind = enNounAt(tokens, i + 1 + j);
      if (!kind) continue;
      const between = window.slice(0, j);
      if (isTalk) {
        // "talk ABOUT the staff" is not a request: a talking verb must be followed by to / with / through / over before the person.
        if (between.some((w) => EN_PREP.has(w)) && !between.some((w) => w === 'about' || w === 'on')) return `en:talk-${kind}`;
      } else if (kind === 'strong') {
        return isGet ? 'en:get-strong' : 'en:want-strong';
      } else if (isWant && between.some((w) => EN_TALK.has(w)) && between.some((w) => EN_PREP.has(w))) {
        return 'en:want-talk-weak'; // "I need to speak to a manager"
      }
    }
  }
  // "real person please", "human pls", "a live agent"
  const allowed = new Set(['a', 'an', 'the', 'real', 'live', 'human', 'person', 'agent', 'representative', 'rep', 'please', 'plz', 'pls', 'now', 'operator', 'customer', 'service', 'support', 'care', 'urgent', 'asap', 'actual']);
  if (n >= 1 && n <= 4 && tokens.every((t) => allowed.has(t)) && tokens.some((t, i) => enNounAt(tokens, i) === 'strong' || (t === 'agent' && tokens.includes('please')))) return 'en:short';
  return null;
}

// ---------------------------------------------------------------- Arabic

const AR_TALK = new Set(['اكلم', 'اتكلم', 'اتحدث', 'احكي', 'اتواصل', 'كلم', 'كلمني', 'كلموني', 'تكلم', 'حولني', 'حولوني', 'وصلني', 'وصلوني', 'خليني', 'بكلم', 'نتواصل', 'التحدث', 'الكلام', 'الحديث', 'التكلم', 'التواصل', 'محادثه', 'المحادثه', 'اكلمه', 'اتكلمه']);
const AR_WANT = new Set(['اريد', 'ابي', 'ابغي', 'ابغا', 'ابا', 'احتاج', 'محتاج', 'محتاجه', 'عايز', 'عاوز', 'اود', 'ودي', 'بغيت', 'نريد', 'نبي', 'نبغي', 'ابى', 'احب', 'يلزمني', 'لازم']);
const AR_NEG = new Set(['لا', 'ما', 'مو', 'مش', 'بدون', 'بلا', 'لن', 'لست', 'ليس']);
const AR_STRONG = new Set(['موظف', 'موظفه', 'موظفين', 'موظفي', 'انسان', 'انسانه', 'بشري', 'بشر', 'ممثل', 'ممثله', 'مسوول', 'مسوله']);
const AR_WEAK = new Set(['شخص', 'حد', 'احد', 'مدير', 'مديره', 'مشرف', 'مشرفه', 'فريق', 'زميل']);
const AR_BLOCK = new Set(['اشكر', 'اشكره', 'اشكرك', 'شكر', 'اشيد', 'امدح', 'وظيفه', 'وظايف', 'توظيف', 'اتقدم', 'تقديم', 'راتب', 'تقييم']);
const AR_PRONOUN_THIRD = new Set(['هو', 'هي', 'هم', 'يريد', 'تريد', 'يبغي', 'يبي', 'يحتاج', 'العميل', 'عميل']);

function arabicStems(token: string): string[] {
  const out = [token];
  for (const cut of [1, 2, 3]) if (token.length - cut >= 3) out.push(token.slice(cut));
  return out;
}

function arNounAt(tokens: string[], i: number): 'strong' | 'weak' | null {
  const stems = arabicStems(tokens[i]!);
  const next = tokens[i + 1] ?? '';
  if (stems.includes('خدمه') && /^(ال)?عملاء/.test(next)) return 'strong';
  if (stems.includes('شخص') && /^(ال)?(حقيقي|بشري|فعلي)/.test(next)) return 'strong';
  if (stems.some((s) => AR_STRONG.has(s))) return 'strong';
  if (stems.some((s) => AR_WEAK.has(s))) return /^(اخر|اخرين)/.test(next) ? null : 'weak';
  return null;
}

function arabicRule(tokens: string[]): string | null {
  const n = tokens.length;
  const joined = tokens.join(' ');
  // "لا اريد التحدث الى بوت" — a refusal to talk to a machine is the request.
  if (/(?:لا|ما|مو|مش)\s*(?:اريد|ابي|ابغي|ابغا|ابا|احب)?\s*(?:ان\s*)?(?:اتحدث|اتكلم|اكلم|احكي|التحدث|الكلام)\s*(?:الي|مع|ب)?\s*(?:ال)?(?:بوت|روبوت|ذكاء|الي|الاله|برنامج)/.test(joined)) return 'ar:not-a-bot';

  for (let i = 0; i < n; i += 1) {
    const t = tokens[i]!;
    const before = tokens.slice(Math.max(0, i - 3), i);
    const negatedByPrefix = /^(?:ما|لا|مو|مش)(?:اريد|ابي|ابغي|ابغا|ابا|احب|اتحدث|اتكلم|اكلم)/.test(t);
    if (negatedByPrefix || before.some((w) => AR_NEG.has(w))) continue;
    if (AR_PRONOUN_THIRD.has(tokens[i - 1] ?? '') || AR_PRONOUN_THIRD.has(t)) continue;
    const isTalk = AR_TALK.has(t);
    const isWant = AR_WANT.has(t);
    if (!isTalk && !isWant) continue;
    const window = tokens.slice(i + 1, i + 7);
    if (window.some((w) => AR_BLOCK.has(w)) || tokens.slice(Math.max(0, i - 2), i).some((w) => AR_BLOCK.has(w))) continue;
    for (let j = 0; j < window.length; j += 1) {
      const kind = arNounAt(tokens, i + 1 + j);
      if (!kind) continue;
      if (kind === 'strong') return isTalk ? 'ar:talk-strong' : 'ar:want-strong';
      const between = window.slice(0, j);
      if (isTalk || between.some((w) => AR_TALK.has(w))) return 'ar:talk-weak';
    }
  }
  // Short phrases without a verb: "شخص حقيقي", "موظف من فضلك", "خدمة العملاء لو سمحت"
  const filler = new Set(['من', 'فضلك', 'فضلكم', 'لو', 'سمحت', 'سمحتي', 'ارجوك', 'ضروري', 'الان', 'حاليا', 'يا', 'رجاء']);
  if (n >= 1 && n <= 5 && tokens.every((t, i) => filler.has(t) || arNounAt(tokens, i) === 'strong' || /^(?:ال)?(?:حقيقي|بشري|عملاء)$/.test(t) || t === 'خدمه') && tokens.some((_, i) => arNounAt(tokens, i) === 'strong')) return 'ar:short';
  return null;
}

// ---------------------------------------------------------------- the decision

export function detectHumanHandoffIntent(text: string | undefined | null, options: { inGuidedFlow?: boolean } = {}): HumanHandoffIntent {
  const raw = (text ?? '').trim();
  if (!raw) return NONE;
  if (isHumanSupportRequest(raw)) return { requested: true, confidence: 'exact', rule: 'keyword' };
  const normalized = normalizeIntentText(raw);
  if (!normalized) return NONE;
  if (EXACT.has(normalized)) return { requested: true, confidence: 'exact', rule: 'keyword-normalised' };
  if (options.inGuidedFlow) return NONE;

  // Evaluate clause by clause so "I don't want a bot, I want a human" is read as two statements.
  const clauses = normalized.split(/\b(?:but|however|instead|rather|so|then)\b|(?:^|\s)(?:لكن|بل|بدل|ولكن)(?=\s)/).map((c) => c.trim()).filter(Boolean);
  const candidates = clauses.length > 1 ? [...clauses, normalized] : [normalized];
  for (const clause of candidates) {
    const tokens = clause.split(' ');
    if (tokens.length > 60) continue;
    const hasArabic = /[ء-ي]/.test(clause);
    const rule = (hasArabic ? arabicRule(tokens) : null) ?? englishRule(tokens);
    if (rule) return { requested: true, confidence: 'high', rule };
  }
  return NONE;
}
