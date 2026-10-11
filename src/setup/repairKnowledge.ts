import { listKnowledgeFiles, writeKnowledgeFile } from '../dashboard/knowledgeAdmin';
import { generateDraftContent } from './generator';
import { knowledgeBlocks, wrapBlock } from './applyDraft';

/**
 * Creates the knowledge files an account is MISSING (or that exist but are empty) from the business information that account has
 * actually stored — its profile, its saved links and its uploaded documents — through the same grounded generator as "Analyze &
 * Generate". It is deliberately conservative:
 *
 *  - a file that already holds text is never touched, so hand-written content is never overwritten just to make a status say
 *    "Available";
 *  - every account is read and written separately (account-scoped sources, account-scoped directory), so nothing is copied
 *    between businesses;
 *  - a fact the sources do not state stays "Not provided" in the file; nothing is invented, and a file whose sections cannot be
 *    derived at all is simply not created.
 */

export const REPAIRABLE_KNOWLEDGE_FILES = ['business.md', 'services.md', 'faq.md', 'policies.md', 'ai-knowledge.md'] as const;

export interface KnowledgeRepairReport {
  accountId: number;
  dryRun: boolean;
  /** Files written (or, in a dry run, that would be written) with their size in bytes. */
  created: Array<{ file: string; bytes: number }>;
  /** Files left alone because they already contain text. */
  keptExisting: string[];
  /** Missing files the stored sources cannot support, so none was created. */
  notDerivable: string[];
  /** In a dry run: the exact text each file would get. */
  preview: Record<string, string>;
}

export async function repairMissingKnowledge(accountId: number, options: { dryRun?: boolean; useAi?: boolean } = {}): Promise<KnowledgeRepairReport> {
  const dryRun = options.dryRun ?? false;
  const report: KnowledgeRepairReport = { accountId, dryRun, created: [], keptExisting: [], notDerivable: [], preview: {} };
  const state = new Map(listKnowledgeFiles(accountId).map((f) => [f.name, f.state]));
  const { content, sources } = await generateDraftContent(accountId, { useAi: options.useAi ?? false });
  const blocks = knowledgeBlocks(content, { en: sources.business.nameEn, ar: sources.business.nameAr });
  // With nothing stored, business.md would be a page of "Not provided" and policies.md only platform boilerplate: not facts, so not files.
  const c = content;
  const hasStoredFacts = Boolean(
    c.profile.detailedEn || c.profile.detailedAr || c.hours.en || c.hours.ar || c.location.addressEn || c.location.addressAr || c.location.mapsUrl
      || c.location.notesEn || c.location.notesAr || c.contact.phone || c.contact.email || c.contact.website
      || c.services.length || c.products.length || c.categories.length || c.faqs.length || c.aiKnowledge.length,
  );

  for (const file of REPAIRABLE_KNOWLEDGE_FILES) {
    const current = state.get(file);
    if (current !== 'missing' && current !== 'empty') {
      report.keptExisting.push(file); // 'available' and 'invalid' both hold content a person may want: never overwritten here
      continue;
    }
    const inner = hasStoredFacts ? blocks[file] : undefined;
    if (!inner) {
      report.notDerivable.push(file);
      continue;
    }
    const text = `${wrapBlock(inner)}\n`;
    report.created.push({ file, bytes: Buffer.byteLength(text, 'utf-8') });
    if (dryRun) report.preview[file] = text;
    else writeKnowledgeFile(file, text, accountId);
  }
  return report;
}
