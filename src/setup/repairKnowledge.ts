import { listKnowledgeFiles, writeKnowledgeFile } from '../dashboard/knowledgeAdmin';
import { generateDraftContent } from './generator';
import { knowledgeBlocks, wrapBlock } from './applyDraft';
import type { SetupSources } from './sources';

/**
 * Creates the knowledge files an account is MISSING (or that exist but are empty) from the business information that account has
 * actually stored — its profile, its saved links and its uploaded documents — through the same grounded generator as "Analyze &
 * Generate". It is deliberately conservative:
 *
 *  - a file that already holds text is never touched, so hand-written content is never overwritten just to make a status say
 *    "Available";
 *  - every account is read and written separately (account-scoped sources, account-scoped directory), so nothing is copied
 *    between businesses;
 *  - a fact the sources do not state stays "Not provided" in the file; nothing is invented. When a core file has nothing real to
 *    hold, it is created as an explicit placeholder that says nothing was provided and tells the assistant not to guess (the same
 *    convention the original business's files use) — never as made-up policies, prices or services. Placeholders are marked so the
 *    dashboard can say so, and a later "Analyze & Generate" (merge) replaces them with real content.
 *  - the platform's own process wording (how appointments, quotations and staff hand-over work) is never written into policies.md:
 *    it is not a fact about the business.
 */

export const REPAIRABLE_KNOWLEDGE_FILES = ['business.md', 'services.md', 'faq.md', 'policies.md', 'ai-knowledge.md'] as const;

/** Marks a file that only states that nothing was provided yet; the dashboard shows it as a placeholder. */
export const KNOWLEDGE_PLACEHOLDER_MARKER = '<!-- knowledge:placeholder -->';

export interface KnowledgeRepairReport {
  accountId: number;
  dryRun: boolean;
  /** Files written (or, in a dry run, that would be written) with their size in bytes. */
  created: Array<{ file: string; bytes: number; placeholder: boolean }>;
  /** Files left alone because they already contain text. */
  keptExisting: string[];
  /** Missing files the stored sources cannot support, so none was created. */
  notDerivable: string[];
  /** In a dry run: the exact text each file would get. */
  preview: Record<string, string>;
}

const documentTitles = (sources: SetupSources): string[] => sources.texts.filter((t) => t.kind === 'document').map((t) => t.label);

function placeholderFor(file: string, sources: SetupSources): string | null {
  const docs = documentTitles(sources);
  switch (file) {
    case 'services.md':
      return [
        KNOWLEDGE_PLACEHOLDER_MARKER,
        '## Services, products and prices',
        'No service list or price list has been provided for this business yet.',
        '- Do not state, guess or imply any service, product, price, stock level or availability that is not written in the business profile, current offers, documents or catalogues.',
        '- If a customer asks for a price, say the team will confirm it and offer a quotation or to connect them with the team.',
        ...(docs.length ? [`- Product information is in the uploaded documents: ${docs.join('; ')}.`] : []),
      ].join('\n');
    case 'faq.md':
      return [
        KNOWLEDGE_PLACEHOLDER_MARKER,
        '## Frequently asked questions',
        'No frequently asked questions have been provided for this business yet.',
        '- Answer only from the business profile, current offers, documents and catalogues. If the answer is not there, say you do not have that information and offer to connect the customer with the team.',
      ].join('\n');
    case 'policies.md':
      return [
        KNOWLEDGE_PLACEHOLDER_MARKER,
        '## Policies',
        'No policies (for example returns, warranty, delivery, payment or cancellation) have been provided for this business yet.',
        '- Never state or imply a policy. If a customer asks about one, say the team will confirm it and offer to connect them with the team.',
      ].join('\n');
    case 'ai-knowledge.md': {
      const lines = [
        ...docs.map((d) => `- Document: ${d}`),
        ...sources.texts.filter((t) => t.kind === 'link').map((t) => `- Page: ${t.label}${t.url ? ` — ${t.url}` : ''}`),
      ];
      return lines.length
        ? ['## Information sources on file for this business', 'The full text of these sources is given to the assistant separately; this list only names them. It states no prices or terms.', ...lines].join('\n')
        : null;
    }
    default:
      return null;
  }
}

export async function repairMissingKnowledge(accountId: number, options: { dryRun?: boolean; useAi?: boolean } = {}): Promise<KnowledgeRepairReport> {
  const dryRun = options.dryRun ?? false;
  const report: KnowledgeRepairReport = { accountId, dryRun, created: [], keptExisting: [], notDerivable: [], preview: {} };
  const state = new Map(listKnowledgeFiles(accountId).map((f) => [f.name, f.state]));
  const { content, sources } = await generateDraftContent(accountId, { useAi: options.useAi ?? false });
  const blocks = knowledgeBlocks(content, { en: sources.business.nameEn, ar: sources.business.nameAr });
  // With nothing stored at all, every file would be empty talk: a business with no information gets no files from this tool.
  const c = content;
  const hasStoredFacts = Boolean(
    c.profile.detailedEn || c.profile.detailedAr || c.hours.en || c.hours.ar || c.location.addressEn || c.location.addressAr || c.location.mapsUrl
      || c.location.notesEn || c.location.notesAr || c.contact.phone || c.contact.email || c.contact.website
      || c.services.length || c.products.length || c.categories.length || c.faqs.length || c.aiKnowledge.length || sources.texts.length,
  );

  for (const file of REPAIRABLE_KNOWLEDGE_FILES) {
    const current = state.get(file);
    if (current !== 'missing' && current !== 'empty') {
      report.keptExisting.push(file); // 'available' and 'invalid' both hold content a person may want: never overwritten here
      continue;
    }
    // policies.md never takes the generator's block: that block is platform process wording, not business facts.
    const derived = file === 'policies.md' ? undefined : blocks[file];
    const placeholder = derived ? null : placeholderFor(file, sources);
    const inner = hasStoredFacts ? derived ?? placeholder : null;
    if (!inner) {
      report.notDerivable.push(file);
      continue;
    }
    const text = `${wrapBlock(inner)}\n`;
    report.created.push({ file, bytes: Buffer.byteLength(text, 'utf-8'), placeholder: inner.includes(KNOWLEDGE_PLACEHOLDER_MARKER) });
    if (dryRun) report.preview[file] = text;
    else writeKnowledgeFile(file, text, accountId);
  }
  return report;
}
