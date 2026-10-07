import { createHash } from 'node:crypto';
import { getDb } from '../memory/db';
import { runWithAccount, LEGACY_ACCOUNT_ID } from '../accounts/accountContext';
import {
  businessSettingsInputSchema, getBusinessSettings, getBusinessSettingsOverrides, updateBusinessSettings,
} from '../config/businessSettings';
import { readKnowledgeFile, writeKnowledgeFile, KnowledgeFileError } from '../dashboard/knowledgeAdmin';
import { createOffer, listOffers, updateOffer } from '../offers/offerRepo';
import { getTemplate, publishTemplate, saveTemplateDraft } from '../templates/templateRepo';
import { getMenuConfig, renderMainMenuText, saveMenuConfig } from '../automation/menuConfig';
import { markApplied, recordStaged, getDraft, DraftStateError, type ApplyReport, type ApplyReportEntry } from './draftRepo';
import { nameKey } from './menuGenerator';
import type { DraftContent, DraftItem } from './types';

/**
 * Applies a reviewed draft. Nothing is ever written by "Analyze & Generate"
 * itself; this is the only place generated content reaches live data, and it
 * does so by an explicit mode:
 *
 *  save_draft  Stage only: templates become unpublished drafts and offers stay
 *              offers in draft status; nothing customers can see changes.
 *  merge       Safe fill: empty profile fields are filled; templates the owner
 *              never edited are updated while edited ones only receive the
 *              generated text as an unpublished draft; generated knowledge
 *              blocks are refreshed unless a person edited them; the menu is
 *              only replaced if it was never customised. Hand-written text is
 *              never touched.
 *  replace     Overwrites existing content with the draft (profile fields,
 *              knowledge files — backed up first —, templates, menu). Needs the
 *              explicit confirmation "REPLACE".
 * Generated offers are always created as DRAFT offers: staff publish them.
 */

export type ApplyMode = 'save_draft' | 'merge' | 'replace';
export type ApplySection = 'profile' | 'knowledge' | 'offers' | 'templates' | 'menu';
export const APPLY_SECTIONS: ApplySection[] = ['profile', 'knowledge', 'offers', 'templates', 'menu'];

export class ApplyError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- knowledge blocks

const BEGIN_RE = /<!-- setup:begin v1 hash=([0-9a-f]{10}) -->\n([\s\S]*?)\n<!-- setup:end -->/;

function hashOf(text: string): string {
  return createHash('sha1').update(text.trim()).digest('hex').slice(0, 10);
}

function wrapBlock(inner: string): string {
  const body = inner.trim();
  return `<!-- setup:begin v1 hash=${hashOf(body)} -->\n${body}\n<!-- setup:end -->`;
}

const na = 'Not provided';
const both = (en: string | null, ar: string | null): string => [en, ar].filter(Boolean).join(' / ');

function itemLine(i: DraftItem): string | null {
  const name = both(i.nameEn, i.nameAr);
  if (!name) return null;
  const desc = [i.descriptionEn, i.descriptionAr].filter(Boolean).join(' / ');
  return `- ${name} — price: ${i.price ?? na}${desc ? ` — ${desc}` : ''}`;
}

function list(items: DraftItem[]): string[] {
  return items.filter((i) => i.include).map(itemLine).filter((l): l is string => Boolean(l));
}

export function knowledgeBlocks(content: DraftContent, name: { en: string; ar: string | null }): Record<string, string> {
  const out: Record<string, string> = {};
  const c = content;
  const businessParts: string[] = [`## About ${both(name.en, name.ar)}`];
  const description = [c.profile.detailedEn, c.profile.detailedAr].filter(Boolean);
  businessParts.push(description.length ? description.join('\n\n') : `Business description: ${na}.`);
  businessParts.push(`## Opening hours\n${[c.hours.en, c.hours.ar].filter(Boolean).join('\n') || `${na} — do not state opening hours.`}`);
  const loc = [
    c.location.addressEn ? `Address (EN): ${c.location.addressEn}` : null,
    c.location.addressAr ? `Address (AR): ${c.location.addressAr}` : null,
    c.location.mapsUrl ? `Google Maps: ${c.location.mapsUrl}` : null,
    c.location.notesEn ? `Notes: ${c.location.notesEn}` : null,
    c.location.notesAr ? `Notes (AR): ${c.location.notesAr}` : null,
  ].filter(Boolean);
  businessParts.push(`## Location\n${loc.length ? loc.join('\n') : `Address: ${na}.`}`);
  const contact = [
    c.contact.phone ? `Phone: ${c.contact.phone}` : null,
    c.contact.email ? `Email: ${c.contact.email}` : null,
    c.contact.website ? `Website: ${c.contact.website}` : null,
  ].filter(Boolean);
  businessParts.push(`## Contact\n${contact.length ? contact.join('\n') : `Contact details: ${na}.`}`);
  out['business.md'] = businessParts.join('\n\n');

  const services = list(c.services);
  const products = list(c.products);
  const categories = list(c.categories);
  if (services.length || products.length || categories.length) {
    const parts: string[] = [];
    if (services.length) parts.push(`## Services\n${services.join('\n')}`);
    if (products.length) parts.push(`## Products\n${products.join('\n')}`);
    if (categories.length) parts.push(`## Categories, brands and colours\n${categories.join('\n')}`);
    parts.push('Prices are listed only where the business published them; "Not provided" means the price is given on request — never guess a price.');
    out['services.md'] = parts.join('\n\n');
  }

  const faqs = c.faqs.filter((f) => f.include).map((f) => {
    const q = both(f.questionEn, f.questionAr);
    const a = both(f.answerEn, f.answerAr);
    return q && a ? `**Q:** ${q}\n**A:** ${a}` : null;
  }).filter((x): x is string => Boolean(x));
  if (faqs.length) out['faq.md'] = `## Frequently asked questions\n\n${faqs.join('\n\n')}`;

  const policy: string[] = [];
  if (c.appointmentInfo.en || c.appointmentInfo.ar) policy.push(`## Appointments\n${both(c.appointmentInfo.en, c.appointmentInfo.ar)}`);
  if (c.quotationInfo.en || c.quotationInfo.ar) policy.push(`## Quotations\n${both(c.quotationInfo.en, c.quotationInfo.ar)}`);
  if (c.handoffInfo.en || c.handoffInfo.ar) policy.push(`## Talking to a person\n${both(c.handoffInfo.en, c.handoffInfo.ar)}`);
  if (c.outOfHours.en || c.outOfHours.ar) policy.push(`## Outside opening hours\n${both(c.outOfHours.en, c.outOfHours.ar)}`);
  if (policy.length) out['policies.md'] = policy.join('\n\n');

  const knowledge = c.aiKnowledge.filter((k) => k.include).map((k) => `- **${k.title}**: ${k.text} _(source: ${k.source})_`);
  if (knowledge.length) out['ai-knowledge.md'] = `## Facts from the business's own documents and pages\n${knowledge.join('\n')}`;
  return out;
}

type BlockResult = { action: 'written' | 'kept'; detail: string };

function applyBlock(file: string, inner: string, mode: ApplyMode, accountId: number, backups: string[]): BlockResult {
  const block = wrapBlock(inner);
  let existing: string | null = null;
  try {
    existing = readKnowledgeFile(file, accountId).content;
  } catch (error) {
    if (!(error instanceof KnowledgeFileError && error.status === 404)) throw error;
  }
  if (mode === 'replace') {
    const result = writeKnowledgeFile(file, `${block}\n`, accountId);
    if (result.backedUpAs) backups.push(`${file} → ${result.backedUpAs}`);
    return { action: 'written', detail: `${file}: replaced${existing ? ' (previous version backed up)' : ''}` };
  }
  // merge
  if (existing === null || !existing.trim()) {
    writeKnowledgeFile(file, `${block}\n`, accountId);
    return { action: 'written', detail: `${file}: created` };
  }
  const match = BEGIN_RE.exec(existing);
  if (!match) {
    const result = writeKnowledgeFile(file, `${existing.replace(/\s+$/, '')}\n\n${block}\n`, accountId);
    if (result.backedUpAs) backups.push(`${file} → ${result.backedUpAs}`);
    return { action: 'written', detail: `${file}: generated section appended below your existing text` };
  }
  if (hashOf(match[2]!) !== match[1]) {
    return { action: 'kept', detail: `${file}: the generated section was edited by hand — left unchanged (use Replace to overwrite it)` };
  }
  const result = writeKnowledgeFile(file, existing.replace(BEGIN_RE, () => block), accountId);
  if (result.backedUpAs) backups.push(`${file} → ${result.backedUpAs}`);
  return { action: 'written', detail: `${file}: generated section refreshed` };
}

// ---------------------------------------------------------------- the apply

export interface ApplyOptions {
  mode: ApplyMode;
  confirm?: string;
  sections?: ApplySection[];
  actor: string;
}

/** True while no person has changed the template: not customised, and any unpublished draft is one this setup tool staged. */
const untouched = (t: { isModified: boolean; hasDraft: boolean; updatedBy: string | null }): boolean => !t.isModified && (!t.hasDraft || Boolean(t.updatedBy?.startsWith('setup:')));

export function applyDraft(accountId: number, draftId: number, options: ApplyOptions): ApplyReport {
  return runWithAccount(accountId, () => {
    const draft = getDraft(draftId, accountId);
    if (!draft) throw new ApplyError('Draft not found', 404);
    if (draft.status !== 'draft') throw new DraftStateError('This draft was already applied or discarded.');
    const { mode } = options;
    if (!['save_draft', 'merge', 'replace'].includes(mode)) throw new ApplyError('mode must be save_draft, merge or replace');
    if (mode === 'replace' && options.confirm !== 'REPLACE') {
      throw new ApplyError('Replacing existing content needs explicit confirmation: send confirm = "REPLACE".');
    }
    const sections = new Set((options.sections?.length ? options.sections : APPLY_SECTIONS).filter((s) => APPLY_SECTIONS.includes(s)));
    const content = draft.content;
    const entries: ApplyReportEntry[] = [];
    const report: ApplyReport = { mode, entries, backups: [], knowledgeChanged: false };
    const add = (section: ApplyReportEntry['section'], action: ApplyReportEntry['action'], detail: string): void => { entries.push({ section, action, detail }); };
    const by = `setup:${options.actor}`;
    const db = getDb();
    const settings = getBusinessSettings(accountId);

    // ---- DB writes in one transaction ------------------------------------------------
    db.transaction(() => {
      // menu first: the menu pages (templates) only exist once the structure is saved
      let menuApplied = false;
      const builtInMenu = accountId === LEGACY_ACCOUNT_ID;
      if (sections.has('menu')) {
        if (builtInMenu) {
          add('menu', 'skipped', 'The original business keeps its built-in menu structure; edit its wording in the Manual Reply Editor.');
        } else if (mode === 'save_draft') {
          add('menu', 'skipped', 'The menu structure changes how customers navigate, so it is only applied with Merge or Replace.');
        } else if (content.menu.items.length === 0) {
          add('menu', 'skipped', 'The draft has no menu.');
        } else {
          const stored = getMenuConfig(accountId);
          const mainMenu = getTemplate('main_menu', db, accountId);
          const mainMenuUntouched = mainMenu ? untouched(mainMenu) : true;
          if (mode === 'merge' && (stored.source !== 'default' || !mainMenuUntouched)) {
            add('menu', 'kept', 'This business already has a customised menu or main-menu text — it was not replaced. Use Replace to overwrite it.');
          } else {
            saveMenuConfig(accountId, content.menu, 'generated', db);
            menuApplied = true;
            add('menu', 'applied', `Menu with ${content.menu.items.length} options saved.`);
          }
        }
      }

      if (sections.has('profile')) {
        if (mode === 'save_draft') {
          add('profile', 'skipped', 'Business Information is not changed by Save as draft.');
        } else {
          const overrides = getBusinessSettingsOverrides(accountId);
          const candidates: [string, unknown, boolean][] = [
            ['descriptionEn', content.profile.detailedEn, overrides.descriptionEn],
            ['descriptionAr', content.profile.detailedAr, overrides.descriptionAr],
            ['addressEn', content.location.addressEn, overrides.addressEn],
            ['addressAr', content.location.addressAr, overrides.addressAr],
            ['googleMapsUrl', content.location.mapsUrl, overrides.googleMapsUrl],
            ['locationNotesEn', content.location.notesEn, overrides.locationNotesEn],
            ['locationNotesAr', content.location.notesAr, overrides.locationNotesAr],
            ['contactPhone', content.contact.phone, overrides.contactPhone],
            ['contactEmail', content.contact.email, overrides.contactEmail],
          ];
          const patch: Record<string, unknown> = {};
          const kept: string[] = [];
          for (const [field, value, hasValue] of candidates) {
            if (value === null || value === undefined || value === '') continue;
            if (mode === 'merge' && hasValue) { kept.push(field); continue; }
            // Each field must pass its own validation rule; one bad value never blocks the others.
            if (businessSettingsInputSchema.safeParse({ [field]: value }).success) patch[field] = value;
          }
          if (Object.keys(patch).length) {
            updateBusinessSettings(patch, accountId);
            add('profile', 'applied', `Updated: ${Object.keys(patch).join(', ')}.`);
          } else {
            add('profile', 'skipped', 'No empty profile fields to fill.');
          }
          if (kept.length) add('profile', 'kept', `Left as you wrote them: ${kept.join(', ')}.`);
        }
      }

      if (sections.has('templates') && builtInMenu) {
        add('templates', 'skipped', 'The original business keeps its own reply wording; edit it in the Manual Reply Editor.');
      } else if (sections.has('templates')) {
        let applied = 0;
        let staged = 0;
        let keptLive = 0;
        let missing = 0;
        const replies = content.autoReplies.filter((t) => t.include);
        // The main menu must always match the saved structure.
        if (menuApplied && !replies.some((t) => t.key === 'main_menu')) {
          replies.push({ key: 'main_menu', titleEn: 'Main Menu', titleAr: 'القائمة الرئيسية', en: renderMainMenuText(content.menu, 'en'), ar: renderMainMenuText(content.menu, 'ar'), include: true });
        }
        for (const t of replies) {
          const existing = getTemplate(t.key, db, accountId);
          if (!existing) { missing += 1; continue; }
          if (mode === 'save_draft') { saveTemplateDraft(t.key, { ar: t.ar, en: t.en }, by, db, accountId); staged += 1; continue; }
          if (mode === 'replace' || untouched(existing) || (menuApplied && ['main_menu'].includes(t.key))) {
            publishTemplate(t.key, { ar: t.ar, en: t.en }, by, db, accountId);
            applied += 1;
          } else {
            saveTemplateDraft(t.key, { ar: t.ar, en: t.en }, by, db, accountId);
            keptLive += 1;
          }
        }
        if (applied) add('templates', 'applied', `${applied} reply template(s) updated.`);
        if (staged) add('templates', 'staged', `${staged} reply template(s) saved as unpublished drafts in the Manual Reply Editor.`);
        if (keptLive) add('templates', 'kept', `${keptLive} template(s) you already customised keep their live text; the generated text is saved as an unpublished draft to review.`);
        if (missing) add('templates', 'skipped', `${missing} template(s) were skipped because their menu entry was not applied.`);
        if (!applied && !staged && !keptLive && !missing) add('templates', 'skipped', 'No reply templates in the draft.');
      }

      if (sections.has('offers')) {
        const existing = listOffers({ accountId });
        const byTitle = new Map(existing.map((o) => [nameKey(o.title_en, o.title_ar), o]));
        let created = 0;
        let updated = 0;
        let skipped = 0;
        for (const o of content.offers.filter((x) => x.include)) {
          const titleEn = o.nameEn ?? o.nameAr;
          const titleAr = o.nameAr ?? o.nameEn;
          if (!titleEn || !titleAr) continue;
          const descriptionEn = [o.descriptionEn ?? '', o.price ? `Price stated in the source: ${o.price} (verify before publishing).` : ''].filter(Boolean).join('\n');
          const descriptionAr = [o.descriptionAr ?? '', o.price ? `السعر المذكور في المصدر: ${o.price} (يرجى التحقق قبل النشر).` : ''].filter(Boolean).join('\n');
          const input = { titleEn, titleAr, descriptionEn, descriptionAr, priceStatus: 'on_request' as const, visibility: 'customer' as const };
          const found = byTitle.get(nameKey(titleEn, titleAr)) ?? byTitle.get(nameKey(titleEn, null)) ?? byTitle.get(nameKey(null, titleAr));
          if (found) {
            if (mode === 'replace') { updateOffer(found.id, { ...input, startsAt: found.starts_at, endsAt: found.ends_at, category: found.category }, by, db, accountId); updated += 1; } else skipped += 1;
            continue;
          }
          createOffer(input, by, db, accountId); // status 'draft': never customer-visible until staff publish it
          created += 1;
        }
        if (created) add('offers', mode === 'save_draft' ? 'staged' : 'applied', `${created} offer(s) created as DRAFT — review and publish them on the Offers page.`);
        if (updated) add('offers', 'applied', `${updated} existing offer(s) updated from the draft.`);
        if (skipped) add('offers', 'kept', `${skipped} offer(s) already exist and were left unchanged.`);
        if (!created && !updated && !skipped) add('offers', 'skipped', 'No offers in the draft.');
      }
    })();

    // ---- knowledge files (after the DB commit; each file is backed up and written atomically) ----
    if (sections.has('knowledge')) {
      if (mode === 'save_draft') {
        add('knowledge', 'skipped', 'Knowledge files have no draft state, so they are only written with Merge or Replace.');
      } else {
        const blocks = knowledgeBlocks(content, { en: settings.businessName, ar: settings.businessNameAr });
        for (const [file, inner] of Object.entries(blocks)) {
          try {
            const result = applyBlock(file, inner, mode, accountId, report.backups);
            if (result.action === 'written') report.knowledgeChanged = true;
            add('knowledge', result.action === 'written' ? 'applied' : 'kept', result.detail);
          } catch (error) {
            add('knowledge', 'error', `${file}: ${(error as Error).message}`);
          }
        }
      }
    }

    if (mode === 'save_draft') recordStaged(draftId, report, accountId);
    else markApplied(draftId, report, accountId);
    return report;
  });
}
