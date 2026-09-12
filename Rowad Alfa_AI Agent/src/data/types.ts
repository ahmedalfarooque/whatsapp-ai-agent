/** Every business fact carries an evidence tag so downstream UI/content
 * generation can distinguish what was actually observed on the public
 * Instagram profile from what is a reasonable design/business inference. */
export type Evidence = 'observed' | 'inferred';

export interface EvidencedText {
  value: string;
  evidence: Evidence;
}

export interface BusinessProfile {
  identity: {
    name: EvidencedText;
    handle: EvidencedText;
    tagline: EvidencedText;
    category: EvidencedText;
  };
  brand: {
    positioning: EvidencedText;
    tone: EvidencedText;
  };
  contentThemes: EvidencedText[];
  location: {
    street: EvidencedText;
    city: EvidencedText;
    country: EvidencedText;
  };
  contact: {
    phones: EvidencedText[];
    instagramUrl: string;
  };
  claims: EvidencedText[];
}

export type ServiceSlug = 'audio-installation' | 'accessory-fitting' | 'infotainment-upgrade' | 'car-care';

export interface Service {
  slug: ServiceSlug;
  name: string;
  shortDescription: string;
  description: string;
  benefits: string[];
  icon: 'speaker' | 'wrench' | 'screen' | 'sparkles';
}

export type ProductCategory = 'audio-systems' | 'accessories-screens';

export interface Product {
  slug: string;
  category: ProductCategory;
  name: string;
  shortDescription: string;
  description: string;
  features: string[];
  applications: string[];
  relatedSlugs: string[];
}

export interface Offer {
  slug: string;
  title: string;
  description: string;
  validity: string;
  badge: string;
}

export interface ContentLibraryItem {
  title: string;
  category: string;
  product: string;
  service: string;
  platform: 'Instagram' | 'Facebook' | 'Cross-platform';
  format: string;
  visualConcept: string;
  copyDirection: string;
  campaign: string;
  status: 'concept' | 'ready' | 'scheduled' | 'published';
}

export interface PlannerEntry {
  day: string;
  platform: 'Instagram' | 'Facebook' | 'Cross-platform';
  contentType: string;
  productOrService: string;
  captionIdea: string;
  imageConcept: string;
  status: 'planned' | 'in-progress' | 'ready';
  scheduledTime: string;
  creativeDirection: string;
}
