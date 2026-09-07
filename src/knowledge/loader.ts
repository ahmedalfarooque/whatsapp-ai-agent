import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';

export interface KnowledgeBase {
  /** Raw markdown/JSON text keyed by file name, concatenated into the system prompt. */
  sections: { fileName: string; content: string }[];
  /** Combined plain-text rendering, ready to interpolate into the system prompt. */
  asPromptText: string;
}

function renderFile(fileName: string, raw: string): string {
  if (fileName.endsWith('.json')) {
    try {
      const parsed = JSON.parse(raw);
      return `### ${fileName}\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
    } catch (error) {
      logger.error({ fileName, error }, 'failed to parse JSON knowledge file, skipping');
      return '';
    }
  }
  return `### ${fileName}\n${raw.trim()}`;
}

/**
 * Loads every .md/.json file directly under `dir` (non-recursive by default,
 * but also walks one level of subdirectories so knowledge/services/*.md works)
 * into an in-memory KnowledgeBase. Called once at boot.
 */
export function loadKnowledgeBase(dir: string): KnowledgeBase {
  const sections: { fileName: string; content: string }[] = [];

  function walk(currentDir: string, relativePrefix: string): void {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativeName = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
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
