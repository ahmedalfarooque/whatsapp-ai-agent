import fs from 'node:fs';
import path from 'node:path';
import { getBusinessSettings, getBusinessSettingsOverrides, formatBusinessHours } from '../config/businessSettings';
import { getAccount } from '../accounts/accountRepo';
import { listLinks, getLinkText, type LinkKind } from './linksRepo';
import { listDocuments } from '../documents/documentStore';
import { listOffers } from '../offers/offerRepo';
import { knowledgeDirForAccount } from '../knowledge/paths';
import { getMenuConfig, type MenuSource } from '../automation/menuConfig';

/**
 * Everything "Analyze & Generate" is allowed to read — for ONE account.
 *
 * Every lookup below takes the account id explicitly (no ambient context), so
 * nothing from another business can enter the analysis. Text sources are
 * labelled with a stable reference (profile, link:<id>, doc:<id>, image:<id>);
 * the generator cites those references and the grounding check verifies each
 * citation against the text that is actually here.
 */

export interface TextSource {
  ref: string;
  kind: 'link' | 'document';
  label: string;
  /** Link category or document purpose, for the analysis prompt. */
  type: string | null;
  url?: string;
  text: string;
}

export interface ImageSource {
  ref: string;
  name: string;
  purpose: string | null;
  caption: string | null;
}

export interface UnavailableSource {
  ref: string;
  label: string;
  reason: string;
}

export interface SetupSources {
  accountId: number;
  business: {
    nameEn: string;
    nameAr: string | null;
    category: string | null;
    descriptionEn: string | null;
    descriptionAr: string | null;
    addressEn: string | null;
    addressAr: string | null;
    mapsUrl: string | null;
    hoursText: { en: string; ar: string } | null;
    locationNotesEn: string | null;
    locationNotesAr: string | null;
    phone: string | null;
    email: string | null;
  };
  /** Public links of any kind, including those that could not be read (shown as unavailable). */
  linkList: { ref: string; kind: LinkKind; label: string | null; url: string }[];
  texts: TextSource[];
  images: ImageSource[];
  unavailable: UnavailableSource[];
  existing: {
    offerTitles: string[];
    knowledge: Record<string, string>;
    menuSource: MenuSource;
  };
}

const MAX_TEXT_PER_SOURCE = 30_000;
const KNOWLEDGE_FILES = ['business.md', 'services.md', 'faq.md', 'policies.md', 'ai-knowledge.md'] as const;

export function collectSources(accountId: number): SetupSources {
  const account = getAccount(accountId);
  if (!account) throw new Error(`whatsapp account ${accountId} does not exist`);
  const settings = getBusinessSettings(accountId);
  const overrides = getBusinessSettingsOverrides(accountId);

  const texts: TextSource[] = [];
  const unavailable: UnavailableSource[] = [];
  const links = listLinks(accountId);
  for (const link of links) {
    const ref = `link:${link.id}`;
    const label = link.label || link.title || link.url;
    if (link.status === 'ok') {
      const text = getLinkText(link.id, accountId);
      if (text) texts.push({ ref, kind: 'link', label, type: link.kind, url: link.url, text: text.slice(0, MAX_TEXT_PER_SOURCE) });
    } else {
      unavailable.push({ ref, label: `${label} (${link.url})`, reason: link.status === 'pending' ? 'Not read yet — use "Read links" first.' : link.error || 'The page could not be read.' });
    }
  }

  const images: ImageSource[] = [];
  for (const doc of listDocuments({ accountId, status: 'active' })) {
    const ref = doc.extension === 'png' || doc.extension === 'jpg' || doc.extension === 'jpeg' || doc.extension === 'webp' ? `image:${doc.id}` : `doc:${doc.id}`;
    if (ref.startsWith('image:')) {
      images.push({ ref, name: doc.title || doc.original_name, purpose: doc.purpose, caption: doc.caption });
      continue;
    }
    if (doc.extracted_text) {
      texts.push({ ref, kind: 'document', label: doc.title || doc.original_name, type: doc.purpose, text: doc.extracted_text.slice(0, MAX_TEXT_PER_SOURCE) });
    } else {
      unavailable.push({ ref, label: doc.title || doc.original_name, reason: doc.processing_error || (doc.extension === 'pdf' ? 'No text could be read from this PDF.' : 'This file type has no readable text.') });
    }
  }

  const knowledge: Record<string, string> = {};
  const dir = knowledgeDirForAccount(accountId);
  for (const name of KNOWLEDGE_FILES) {
    try {
      knowledge[name] = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      /* not written yet */
    }
  }

  return {
    accountId,
    business: {
      nameEn: settings.businessName,
      nameAr: settings.businessNameAr,
      category: settings.businessCategory,
      descriptionEn: settings.descriptionEn,
      descriptionAr: settings.descriptionAr,
      addressEn: settings.addressEn,
      addressAr: settings.addressAr,
      mapsUrl: settings.googleMapsConfigured ? settings.googleMapsUrl : null,
      hoursText: settings.hoursConfigured && overrides.businessHoursStart ? { en: formatBusinessHours(settings, 'en'), ar: formatBusinessHours(settings, 'ar') } : null,
      locationNotesEn: settings.locationNotesEn,
      locationNotesAr: settings.locationNotesAr,
      phone: settings.contactPhone,
      email: settings.contactEmail,
    },
    linkList: links.map((l) => ({ ref: `link:${l.id}`, kind: l.kind, label: l.label, url: l.url })),
    texts,
    images,
    unavailable,
    existing: {
      offerTitles: listOffers({ accountId }).map((o) => `${o.title_en} / ${o.title_ar}`),
      knowledge,
      menuSource: getMenuConfig(accountId).source,
    },
  };
}

/** Compact record of what was analysed, stored with the draft so a reviewer can see the basis. */
export function sourceSummary(sources: SetupSources): Record<string, unknown> {
  return {
    texts: sources.texts.map((t) => ({ ref: t.ref, label: t.label, type: t.type, chars: t.text.length })),
    images: sources.images.map((i) => ({ ref: i.ref, name: i.name, purpose: i.purpose, caption: i.caption })),
    unavailable: sources.unavailable,
    links: sources.linkList.length,
    hasProfileDescription: Boolean(sources.business.descriptionEn || sources.business.descriptionAr),
  };
}
