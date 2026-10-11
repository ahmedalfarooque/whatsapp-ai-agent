/**
 * Tells verified business knowledge apart from content that only LOOKS like knowledge: explicit placeholders ("nothing provided yet"),
 * example/template text and almost-empty files. The same verdict is used in two places, so the dashboard and the assistant can never
 * disagree: the Knowledge page labels the file, and the assistant's prompt marks the section as "not verified" so it is never stated
 * to a customer as a fact about the business.
 */
export type KnowledgeQuality = 'verified' | 'placeholder' | 'example';

export interface KnowledgeVerdict {
  quality: KnowledgeQuality;
  /** Short human reason, shown in the dashboard and in the assistant's prompt. */
  reason: string | null;
}

/** Written into files that only state that nothing was provided yet (see setup/repairKnowledge). */
export const PLACEHOLDER_MARKER = '<!-- knowledge:placeholder -->';

const EXAMPLE_TEXT = /EXAMPLE\s*\/\s*PLACEHOLDER|EXAMPLE\s+CONTENT|PLACEHOLDER\s+CONTENT|\(\s*EXAMPLE\s*\)|\bEXAMPLE\b[^\n]{0,40}\bPLACEHOLDER\b/i;
const MIN_WORDS_FOR_REAL_CONTENT = 6;

const stripComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, ' ');

export function classifyKnowledgeText(fileName: string, text: string): KnowledgeVerdict {
  if (text.includes(PLACEHOLDER_MARKER)) return { quality: 'placeholder', reason: 'it states that no information was provided yet' };
  if (fileName.endsWith('.json')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown> | null;
      const comment = parsed && typeof parsed === 'object' ? String(parsed._comment ?? '') : '';
      if (EXAMPLE_TEXT.test(comment)) return { quality: 'example', reason: 'it is marked as example / placeholder content' };
    } catch {
      /* invalid JSON is reported separately by the caller */
    }
    return { quality: 'verified', reason: null };
  }
  // Only the places a template marks itself — HTML comments and headings — so a real file that merely says "(example)" in a sentence is not flagged.
  const markers = [...(text.match(/<!--[\s\S]*?-->/g) ?? []), ...(text.match(/^#+\s.*$/gm) ?? [])].join('\n');
  if (EXAMPLE_TEXT.test(markers)) return { quality: 'example', reason: 'it is marked as example / placeholder content' };
  const words = stripComments(text)
    .replace(/^#+\s.*$/gm, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (words < MIN_WORDS_FOR_REAL_CONTENT) return { quality: 'placeholder', reason: 'it is almost empty (too short to hold business facts)' };
  return { quality: 'verified', reason: null };
}

/** The text an AI prompt should carry: markup comments removed, and a clear warning in front of anything that is not verified. */
export function renderKnowledgeForPrompt(fileName: string, text: string): string {
  const verdict = classifyKnowledgeText(fileName, text);
  const body = stripComments(text).replace(/\n{3,}/g, '\n\n').trim();
  if (verdict.quality === 'verified') return body;
  return `[NOT VERIFIED — ${verdict.reason}. Nothing in this section is a confirmed fact about this business: never state it to a customer, treat the topic as unknown and offer to connect them with the team.]\n${body}`;
}
