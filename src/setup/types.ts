import { z } from 'zod';
import { DEFAULT_GENERIC_MENU, MENU_ITEM_KINDS, validateMenuConfig, type MenuConfig } from '../automation/menuConfig';

/**
 * The shape of an "Analyze & Generate" draft. Every text field may be null,
 * which the UI shows as "Not provided": the generator leaves a field null
 * rather than inventing it. Every extracted fact carries the id of the source
 * it came from (profile, link:<id>, doc:<id>, image:<id>) and, where it was
 * read from text, the verbatim evidence.
 */

const text = (max: number) => z.string().max(max).nullable();
const short = text(400);
const long = text(6000);

export const draftItemSchema = z.object({
  id: z.string().min(1).max(40),
  nameEn: short,
  nameAr: short,
  descriptionEn: text(1500),
  descriptionAr: text(1500),
  /** Price exactly as the source wrote it ("50 SAR"). Null = Not provided. */
  price: text(80),
  source: z.string().max(60),
  evidence: text(400),
  include: z.boolean(),
});

export const draftFaqSchema = z.object({
  id: z.string().min(1).max(40),
  questionEn: short,
  questionAr: short,
  answerEn: text(1500),
  answerAr: text(1500),
  source: z.string().max(60),
  evidence: text(400),
  include: z.boolean(),
});

export const draftTemplateSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,60}$/),
  titleEn: z.string().max(200),
  titleAr: z.string().max(200),
  en: z.string().min(1).max(4000),
  ar: z.string().min(1).max(4000),
  include: z.boolean(),
  /** True once a person rewrote this reply; it is then never regenerated from the draft content. */
  edited: z.boolean().optional(),
});

export const draftKnowledgeSchema = z.object({
  id: z.string().min(1).max(40),
  title: z.string().max(200),
  text: z.string().max(2000),
  source: z.string().max(60),
  include: z.boolean(),
});

const bilingual = z.object({ en: long, ar: long });

export const draftContentSchema = z.object({
  version: z.literal(1),
  category: text(200),
  profile: z.object({
    introEn: long, introAr: long,
    shortEn: text(500), shortAr: text(500),
    detailedEn: long, detailedAr: long,
  }),
  hours: bilingual,
  location: z.object({ addressEn: text(500), addressAr: text(500), mapsUrl: text(500), notesEn: text(1000), notesAr: text(1000) }),
  contact: z.object({ phone: text(60), email: text(200), website: text(500) }),
  services: z.array(draftItemSchema).max(150),
  products: z.array(draftItemSchema).max(300),
  categories: z.array(draftItemSchema).max(100),
  offers: z.array(draftItemSchema).max(60),
  faqs: z.array(draftFaqSchema).max(150),
  appointmentInfo: bilingual,
  quotationInfo: bilingual,
  handoffInfo: bilingual,
  outOfHours: bilingual,
  menu: z.custom<MenuConfig>((value) => {
    try {
      validateMenuConfig(value);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid menu'),
  autoReplies: z.array(draftTemplateSchema).max(80),
  aiKnowledge: z.array(draftKnowledgeSchema).max(200),
  /** Plain statements of what could not be found, e.g. "Prices: Not provided". */
  gaps: z.array(z.string().max(300)).max(60),
});

export type DraftItem = z.infer<typeof draftItemSchema>;
export type DraftFaq = z.infer<typeof draftFaqSchema>;
export type DraftTemplate = z.infer<typeof draftTemplateSchema>;
export type DraftKnowledge = z.infer<typeof draftKnowledgeSchema>;
export type DraftContent = Omit<z.infer<typeof draftContentSchema>, 'menu'> & { menu: MenuConfig };

export const MENU_KINDS_FOR_SCHEMA = MENU_ITEM_KINDS;

export class DraftValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
  }
}

/** Validates an edited draft coming back from the browser (HTTP 400 with a readable path on failure). */
export function parseDraftContent(raw: unknown): DraftContent {
  const result = draftContentSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new DraftValidationError(`Invalid draft: ${issue ? `${issue.path.join('.')} — ${issue.message}` : 'unknown error'}`);
  }
  return { ...result.data, menu: validateMenuConfig(result.data.menu) };
}

export function emptyDraft(): DraftContent {
  const none = { en: null, ar: null };
  return {
    version: 1,
    category: null,
    profile: { introEn: null, introAr: null, shortEn: null, shortAr: null, detailedEn: null, detailedAr: null },
    hours: { ...none },
    location: { addressEn: null, addressAr: null, mapsUrl: null, notesEn: null, notesAr: null },
    contact: { phone: null, email: null, website: null },
    services: [],
    products: [],
    categories: [],
    offers: [],
    faqs: [],
    appointmentInfo: { ...none },
    quotationInfo: { ...none },
    handoffInfo: { ...none },
    outOfHours: { ...none },
    menu: structuredClone(DEFAULT_GENERIC_MENU),
    autoReplies: [],
    aiKnowledge: [],
    gaps: [],
  };
}
