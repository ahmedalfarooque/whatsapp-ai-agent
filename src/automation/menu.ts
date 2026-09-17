import { getBusinessSettings } from '../config/businessSettings';
import type { CustomerLanguage } from '../memory/customerRepo';
import type { OutboundInteractiveMessage } from '../whatsapp/types';

export const GOOGLE_MAPS_LINK = 'https://share.google/QdtvbcoaAlyxfDNZl';

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

const MENU_KEYWORDS: Record<CustomerLanguage, string[]> = {
  en: ['menu', 'main menu', 'services'],
  ar: ['القائمة', 'قائمة', 'الرئيسية', 'الخدمات'],
};

const CHANGE_LANGUAGE_KEYWORDS: Record<CustomerLanguage, string[]> = {
  en: ['change language', 'language'],
  ar: ['تغيير اللغة', 'اللغة'],
};

const LANGUAGE_KEYWORDS: { language: CustomerLanguage; keywords: string[] }[] = [
  { language: 'en', keywords: ['english', 'en'] },
  { language: 'ar', keywords: ['عربي', 'العربية', 'ar'] },
];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** Detects a bare language-name reply typed as free text (fallback for customers who don't tap the buttons). */
export function detectLanguageFromText(text: string | undefined): CustomerLanguage | undefined {
  if (!text) return undefined;
  const normalized = normalize(text);
  return LANGUAGE_KEYWORDS.find((entry) => entry.keywords.includes(normalized))?.language;
}

/** True when the free-text message is a request to see the menu again, in either language. */
export function isMenuKeyword(text: string | undefined, language: CustomerLanguage): boolean {
  if (!text) return false;
  return MENU_KEYWORDS[language].includes(normalize(text));
}

/** True when the free-text message is a request to change the conversation language. */
export function isChangeLanguageKeyword(text: string | undefined, language: CustomerLanguage): boolean {
  if (!text) return false;
  return CHANGE_LANGUAGE_KEYWORDS[language].includes(normalize(text));
}

export function buildLanguageSelectionMessage(): OutboundInteractiveMessage {
  return {
    kind: 'buttons',
    body: 'Please choose your language / يرجى اختيار اللغة',
    buttons: [
      { id: MENU_IDS.LANG_EN, title: 'English' },
      { id: MENU_IDS.LANG_AR, title: 'العربية' },
    ],
  };
}

export function buildWelcomeText(language: CustomerLanguage, customerName: string | undefined): string {
  const businessName = getBusinessSettings().businessName;
  if (language === 'ar') {
    const greeting = customerName ? `أهلاً ${customerName}` : 'أهلاً بك';
    return `${greeting} في ${businessName}! يسعدنا خدمتك. موقعنا على خرائط جوجل: ${GOOGLE_MAPS_LINK}`;
  }
  const greeting = customerName ? `Hello ${customerName}` : 'Hello';
  return `${greeting}, welcome to ${businessName}! We're glad to help. Find us on Google Maps: ${GOOGLE_MAPS_LINK}`;
}

export function buildMainMenuMessage(language: CustomerLanguage): OutboundInteractiveMessage {
  if (language === 'ar') {
    return {
      kind: 'list',
      body: 'كيف يمكننا مساعدتك اليوم؟',
      buttonLabel: 'عرض الخيارات',
      sections: [
        {
          rows: [
            { id: MENU_IDS.CATEGORY_AUDIO, title: 'أنظمة الصوت' },
            { id: MENU_IDS.CATEGORY_ACCESSORIES, title: 'إكسسوارات السيارات' },
            { id: MENU_IDS.CATEGORY_CARE, title: 'العناية بالسيارة' },
            { id: MENU_IDS.PRICES, title: 'الأسعار والاستفسارات' },
            { id: MENU_IDS.LOCATION, title: 'الموقع وساعات العمل' },
          ],
        },
      ],
    };
  }
  return {
    kind: 'list',
    body: 'How can we help you today?',
    buttonLabel: 'Show options',
    sections: [
      {
        rows: [
          { id: MENU_IDS.CATEGORY_AUDIO, title: 'Car Audio' },
          { id: MENU_IDS.CATEGORY_ACCESSORIES, title: 'Car Accessories' },
          { id: MENU_IDS.CATEGORY_CARE, title: 'Car Care' },
          { id: MENU_IDS.PRICES, title: 'Prices & Enquiries' },
          { id: MENU_IDS.LOCATION, title: 'Location & Working Hours' },
        ],
      },
    ],
  };
}

function navigationButtons(language: CustomerLanguage): { id: string; title: string }[] {
  if (language === 'ar') {
    return [
      { id: MENU_IDS.MAIN_MENU, title: 'القائمة الرئيسية' },
      { id: MENU_IDS.CHANGE_LANGUAGE, title: 'تغيير اللغة' },
    ];
  }
  return [
    { id: MENU_IDS.MAIN_MENU, title: 'Main Menu' },
    { id: MENU_IDS.CHANGE_LANGUAGE, title: 'Change language' },
  ];
}

const CATEGORY_PROMPTS: Record<CustomerLanguage, Record<'audio' | 'accessories' | 'care' | 'prices', string>> = {
  en: {
    audio: "Car Audio — ask me about any car audio product or installation and I'll help based on what we offer.",
    accessories: "Car Accessories — ask me about any accessory you're looking for and I'll help based on what we offer.",
    care: "Car Care — ask me about any car care service and I'll help based on what we offer.",
    prices: 'Prices & Enquiries — tell me which service or product you want pricing or details on.',
  },
  ar: {
    audio: 'أنظمة الصوت — اسألني عن أي منتج أو تركيب صوتيات وسأساعدك بناءً على ما نقدمه.',
    accessories: 'إكسسوارات السيارات — اسألني عن أي إكسسوار تبحث عنه وسأساعدك بناءً على ما نقدمه.',
    care: 'العناية بالسيارة — اسألني عن أي خدمة عناية بالسيارة وسأساعدك بناءً على ما نقدمه.',
    prices: 'الأسعار والاستفسارات — أخبرني عن الخدمة أو المنتج الذي تريد معرفة سعره أو تفاصيله.',
  },
};

function buildNavigationOnlyMessage(language: CustomerLanguage, body: string): OutboundInteractiveMessage {
  return { kind: 'buttons', body, buttons: navigationButtons(language) };
}

export function buildCategoryMessage(
  language: CustomerLanguage,
  category: 'audio' | 'accessories' | 'care' | 'prices',
): OutboundInteractiveMessage {
  return buildNavigationOnlyMessage(language, CATEGORY_PROMPTS[language][category]);
}

export function buildLocationMessage(language: CustomerLanguage): OutboundInteractiveMessage {
  const settings = getBusinessSettings();
  const hoursLine =
    language === 'ar'
      ? `ساعات العمل: ${settings.businessHoursStart} - ${settings.businessHoursEnd}`
      : `Working hours: ${settings.businessHoursStart} - ${settings.businessHoursEnd}`;
  const mapsLine = language === 'ar' ? `موقعنا على خرائط جوجل: ${GOOGLE_MAPS_LINK}` : `Find us on Google Maps: ${GOOGLE_MAPS_LINK}`;
  return buildNavigationOnlyMessage(language, `${mapsLine}\n${hoursLine}`);
}
