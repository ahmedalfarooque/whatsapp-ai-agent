import type { KnowledgeBase } from './loader';

/**
 * Bounded knowledge for one prompt. A small knowledge base is pasted whole (today's behaviour). A large one no longer grows the prompt without
 * limit: the sections most relevant to the customer's latest message (lexical overlap, every script) come first, the rest follow in file
 * order, and the total stays inside the character budget — so a business with many knowledge files never pushes a request past the
 * provider's per-prompt token cap (OpenRouter: HTTP 402 "Prompt tokens limit exceeded"). Nothing is rewritten or summarised: sections are
 * included or left out, and the prompt says how many were left out.
 */

export interface KnowledgeSelection {
  text: string;
  includedSections: number;
  totalSections: number;
  /** True when something was left out. */
  trimmed: boolean;
  /** Characters of the selected text. */
  chars: number;
}

const MIN_TOKEN = 3;

function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu)) {
    const t = m[0];
    if (t.length >= MIN_TOKEN) out.add(t);
  }
  return out;
}

function score(sectionText: string, queryTokens: Set<string>, queryLower: string): number {
  if (queryTokens.size === 0) return 0;
  const lower = sectionText.toLowerCase();
  let hits = 0;
  for (const t of queryTokens) if (lower.includes(t)) hits += 1;
  // a whole-phrase hit (3+ word question quoted somewhere) counts extra; codes with digits count extra
  let bonus = 0;
  if (queryLower.length >= 12 && lower.includes(queryLower)) bonus += 3;
  for (const t of queryTokens) if (/\d{3,}/.test(t) && lower.includes(t)) bonus += 2;
  return hits + bonus;
}

export function selectKnowledgeForPrompt(kb: KnowledgeBase, query: string | null | undefined, budgetChars: number): KnowledgeSelection {
  const total = kb.sections.length;
  const whole = kb.asPromptText;
  if (whole.length <= budgetChars) return { text: whole, includedSections: total, totalSections: total, trimmed: false, chars: whole.length };

  const q = (query ?? '').trim();
  const queryTokens = tokens(q);
  const ranked = kb.sections
    .map((s, index) => ({ s, index, score: score(s.content, queryTokens, q.toLowerCase()) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: Array<{ index: number; content: string }> = [];
  let used = 0;
  for (const r of ranked) {
    if (used >= budgetChars) break;
    const remaining = budgetChars - used;
    if (r.s.content.length <= remaining) {
      chosen.push({ index: r.index, content: r.s.content });
      used += r.s.content.length + 2;
    } else if (chosen.length === 0 || r.score > 0) {
      // the most relevant section still gets its head rather than nothing
      const head = r.s.content.slice(0, Math.max(0, remaining - 40));
      if (head.length > 200) { chosen.push({ index: r.index, content: `${head}\n[... section cut to fit the prompt]` }); used += head.length + 42; }
    }
  }
  chosen.sort((a, b) => a.index - b.index); // file order keeps related sections together
  const leftOut = total - chosen.length;
  const text = `${chosen.map((c) => c.content).join('\n\n')}${leftOut > 0 ? `\n\n[${leftOut} knowledge section${leftOut === 1 ? '' : 's'} not shown for this message (prompt size limit); if the answer may be in them, say the team can confirm]` : ''}`;
  return { text, includedSections: chosen.length, totalSections: total, trimmed: true, chars: text.length };
}

/** Trims the oldest turns until the text fits the budget (keeps at least the latest `keepMin` entries). */
export function trimHistoryToBudget<T extends { content: string }>(history: T[], budgetChars: number, keepMin = 4): T[] {
  let total = history.reduce((n, h) => n + (h.content?.length ?? 0), 0);
  let start = 0;
  while (total > budgetChars && history.length - start > keepMin) {
    total -= history[start]!.content?.length ?? 0;
    start += 1;
  }
  return start === 0 ? history : history.slice(start);
}
