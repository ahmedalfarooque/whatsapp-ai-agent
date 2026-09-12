import type { Product, ProductCategory } from './types';

export const categoryLabels: Record<ProductCategory, string> = {
  'audio-systems': 'Audio Systems',
  'accessories-screens': 'Accessories & Screens',
};

export const products: Product[] = [
  {
    slug: 'pioneer-component-speaker-set',
    category: 'audio-systems',
    name: 'Pioneer Component Speaker Set',
    shortDescription: 'Crisp, layered sound built around genuine Pioneer components.',
    description:
      'A component speaker upgrade for drivers who want a noticeably cleaner sound stage than a factory setup — tweeter, mid, and crossover fitted as a matched set.',
    features: ['Genuine Pioneer components', 'Matched crossover network', 'Professional fitting included'],
    applications: ['Daily-driver sound upgrade', 'Pairing with a new head unit'],
    relatedSlugs: ['kenwood-digital-media-receiver'],
  },
  {
    slug: 'kenwood-digital-media-receiver',
    category: 'audio-systems',
    name: 'Kenwood Digital Media Receiver',
    shortDescription: 'A modern Kenwood head unit for phone-first drivers.',
    description:
      'Replace a dated factory stereo with a Kenwood digital media receiver built for phone connectivity, clean menus, and a stronger amp stage.',
    features: ['Genuine Kenwood unit', 'Strong built-in amplification', 'Fitted with clean wiring'],
    applications: ['Head-unit replacement', 'Foundation for a full audio upgrade'],
    relatedSlugs: ['pioneer-component-speaker-set', 'android-infotainment-screen'],
  },
  {
    slug: 'android-infotainment-screen',
    category: 'accessories-screens',
    name: 'Android Infotainment Screen',
    shortDescription: 'A modern Android touchscreen fitted to your dashboard.',
    description:
      'An aftermarket Android screen sized and trimmed to match your dashboard, bringing navigation, media, and app connectivity to older and newer models alike.',
    features: ['Android-based infotainment', 'Model-matched dash fitment', 'Installed and tested in-store'],
    applications: ['Factory-screen replacement', 'Older-model infotainment upgrade'],
    relatedSlugs: ['kenwood-digital-media-receiver'],
  },
  {
    slug: 'interior-exterior-accessory-pack',
    category: 'accessories-screens',
    name: 'Interior & Exterior Accessory Pack',
    shortDescription: 'Popular decoration and protection accessories, fitted same-visit.',
    description:
      'A curated range of interior and exterior accessories — from trim and protection pieces to decoration accents — available retail or wholesale with fitting done on the spot.',
    features: ['Retail & wholesale available', 'Same-visit fitting', 'Wide accessory selection'],
    applications: ['Cosmetic refresh', 'Wholesale accessory sourcing'],
    relatedSlugs: ['android-infotainment-screen'],
  },
];

export function getProductBySlug(slug: string): Product | undefined {
  return products.find((p) => p.slug === slug);
}

export function getProductsByCategory(category: ProductCategory): Product[] {
  return products.filter((p) => p.category === category);
}

export function getRelatedProducts(product: Product): Product[] {
  return product.relatedSlugs
    .map((slug) => getProductBySlug(slug))
    .filter((p): p is Product => Boolean(p));
}
