import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
import { classifyKnowledgeText, renderKnowledgeForPrompt } from './quality';

export interface KnowledgeBase {
  /** Raw markdown/JSON text keyed by file name, concatenated into the system prompt. */
  sections: { fileName: string; content: string }[];
  /** Combined plain-text rendering, ready to interpolate into the system prompt. */
  asPromptText: string;
}

/**
 * Sub-directories of the knowledge root that are never part of a knowledge
 * base: per-account knowledge (each account loads only its own directory)
 * and the dashboard editor's backups.
 */
export const KNOWLEDGE_EXCLUDED_DIRS = ['accounts', '.backups'] as const;

function renderFile(fileName: string, raw: string): string {
  if (fileName.endsWith('.json')) {
    try {
      const parsed = JSON.parse(raw);
      const verdict = classifyKnowledgeText(fileName, raw);
      const warning = verdict.quality === 'verified' ? '' : `[NOT VERIFIED — ${verdict.reason}. Nothing in this section is a confirmed fact about this business: never state it to a customer.]\n`;
      return `### ${fileName}\n${warning}\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
    } catch (error) {
      logger.error({ fileName, error }, 'failed to parse JSON knowledge file, skipping');
      return '';
    }
  }
  return `### ${fileName}\n${renderKnowledgeForPrompt(fileName, raw)}`;
}

/**
 * Loads every .md/.json file under `dir` (walking subdirectories, except the
 * excluded ones) into an in-memory KnowledgeBase. Called once per account
 * when its connection first needs it, and at boot for the webhook path.
 */
export function loadKnowledgeBase(dir: string, options: { excludeDirs?: readonly string[] } = {}): KnowledgeBase {
  const sections: { fileName: string; content: string }[] = [];
  const excluded = new Set(options.excludeDirs ?? KNOWLEDGE_EXCLUDED_DIRS);

  function walk(currentDir: string, relativePrefix: string): void {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativeName = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (!relativePrefix && excluded.has(entry.name)) continue;
        walk(fullPath, relativeName);
        continue;
      }
      if (!entry.name.endsWith('.md') && !entry.name.endsWith('.json')) continue;

      const raw = fs.readFileSync(fullPath, 'utf-8');
      const rendered = renderFile(relativeName, raw);
      if (rendered) sections.push({ fileName: relativeName, content: rendered });
    }
  }

  walk(dir, '');

  if (sections.length === 0) {
    logger.warn({ dir }, 'no knowledge files found — agent will run with no business knowledge');
  }

  const asPromptText = sections.map((s) => s.content).join('\n\n');
  return { sections, asPromptText };
}
