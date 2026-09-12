import type { Service } from './types';

export const services: Service[] = [
  {
    slug: 'audio-installation',
    name: 'Audio System Installation',
    shortDescription: 'Pioneer & Kenwood systems, professionally fitted.',
    description:
      'From a single speaker swap to a full head-unit and speaker overhaul, our fitting team installs original Pioneer and Kenwood audio equipment with clean wiring and a proper in-car tune.',
    benefits: [
      'Original Pioneer & Kenwood equipment',
      'Clean, damage-free wiring and fitting',
      'Warranty on parts and labor',
    ],
    icon: 'speaker',
  },
  {
    slug: 'accessory-fitting',
    name: 'Accessory Fitting',
    shortDescription: 'Retail and wholesale car accessories, fitted on-site.',
    description:
      'A full accessories counter — retail and wholesale — with fitting done the same visit. If it decorates or upgrades your car, we likely stock it or can source it.',
    benefits: ['Retail & wholesale pricing', 'Same-visit fitting', 'Wide accessory range'],
    icon: 'wrench',
  },
  {
    slug: 'infotainment-upgrade',
    name: 'Android Screen Upgrade',
    shortDescription: 'Latest Android head units for older and newer models.',
    description:
      'Swap a factory screen for a modern Android infotainment unit — navigation, media, and connectivity upgrades fitted to match your dashboard.',
    benefits: ['Model-matched fitment', 'Modern Android infotainment', 'Installed and tested in-store'],
    icon: 'screen',
  },
  {
    slug: 'car-care',
    name: 'Car Care & Detailing',
    shortDescription: 'Cosmetic care add-ons alongside your accessory fit.',
    description:
      'Complementary care and detailing services so your car looks as sharp as it sounds after an accessory or audio upgrade.',
    benefits: ['Pairs with any fitting visit', 'Cosmetic finishing touches', 'Simple, no-appointment add-on'],
    icon: 'sparkles',
  },
];
