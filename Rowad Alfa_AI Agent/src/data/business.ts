import type { BusinessProfile } from './types';

/**
 * Everything here traces back to the plan's research section
 * (ROWAD_ALFA_PRODUCT_DESIGN_PLAN.md §1). Observed = read directly from the
 * public Instagram profile/posts. Inferred = a reasonable design/business
 * inference we are not presenting as a verified fact.
 */
export const businessProfile: BusinessProfile = {
  identity: {
    name: { value: 'Rowad Alfa Trading Co.', evidence: 'observed' },
    handle: { value: '@rowad_alfa_auto_care', evidence: 'observed' },
    tagline: {
      value: 'From the first detail to the last touch — your car looks more luxurious and sounds stronger.',
      evidence: 'observed',
    },
    category: { value: 'Car audio, accessories & installation', evidence: 'observed' },
  },
  brand: {
    positioning: {
      value: 'A Jeddah car-audio and accessories specialist for retail, wholesale, and professional fitting.',
      evidence: 'inferred',
    },
    tone: { value: 'Confident, promo-driven, brand-forward (Pioneer, Kenwood).', evidence: 'inferred' },
  },
  contentThemes: [
    { value: 'Audio system installs (Pioneer / Kenwood)', evidence: 'observed' },
    { value: 'Aftermarket Android infotainment screens', evidence: 'observed' },
    { value: 'Car accessories & decoration (زينة السيارات)', evidence: 'observed' },
    { value: 'Installation & fitting offers', evidence: 'observed' },
    { value: 'Car care / detailing add-ons', evidence: 'inferred' },
  ],
  location: {
    street: { value: 'Mohammed Saeed Naseef St, An Nuzhah', evidence: 'observed' },
    city: { value: 'Jeddah', evidence: 'observed' },
    country: { value: 'Saudi Arabia', evidence: 'observed' },
  },
  contact: {
    phones: [
      { value: '05 31 842 393', evidence: 'observed' },
      { value: '055 819 0545', evidence: 'observed' },
    ],
    instagramUrl: 'https://www.instagram.com/rowad_alfa_auto_care/',
  },
  claims: [
    { value: '100% Original Products', evidence: 'observed' },
    { value: 'Warranty on all products & fittings', evidence: 'observed' },
    { value: 'Wholesale, retail & fitting under one roof', evidence: 'observed' },
  ],
};
