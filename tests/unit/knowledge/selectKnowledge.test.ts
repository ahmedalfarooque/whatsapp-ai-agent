import { describe, expect, it } from 'vitest';
import { selectKnowledgeForPrompt, trimHistoryToBudget } from '../../../src/knowledge/select';
import type { KnowledgeBase } from '../../../src/knowledge/loader';

// Prompt size guards (production 2026-10-13: 14k-token prompts were refused by OpenRouter with HTTP 402 "Prompt tokens limit exceeded").
const kb = (parts: Array<[string, string]>): KnowledgeBase => ({ sections: parts.map(([fileName, content]) => ({ fileName, content })), asPromptText: parts.map(([, c]) => c).join('\n\n') });

describe('selectKnowledgeForPrompt', () => {
  it('a knowledge base that fits is pasted whole, unchanged', () => {
    const k = kb([['a.md', 'Window tinting from 350 SAR.'], ['b.md', 'We open 9 to 6.']]);
    const s = selectKnowledgeForPrompt(k, 'tinting price?', 10_000);
    expect(s).toMatchObject({ text: k.asPromptText, trimmed: false, includedSections: 2, totalSections: 2 });
  });
  it('a large one keeps the sections that match the customer\'s message, in file order, inside the budget, and says how many were left out', () => {
    const filler = (n: number) => `Section ${n} about unrelated topic ${'x'.repeat(400)}`;
    const k = kb([['01.md', filler(1)], ['02-tint.md', `Window tinting packages: Basic, Ceramic ${'y'.repeat(300)}`], ['03.md', filler(3)], ['04-ppf.md', `Paint protection film PPF-2024 ${'z'.repeat(300)}`], ['05.md', filler(5)]]);
    const s = selectKnowledgeForPrompt(k, 'how much is window tinting and PPF-2024?', 900);
    expect(s.trimmed).toBe(true);
    expect(s.text).toContain('Window tinting packages');
    expect(s.text).toContain('PPF-2024');
    expect(s.text.indexOf('Window tinting')).toBeLessThan(s.text.indexOf('PPF-2024')); // file order
    expect(s.text).not.toContain('Section 1 about');
    expect(s.text).toMatch(/3 knowledge sections not shown/);
    expect(s.chars).toBeLessThanOrEqual(900 + 120);
  });
  it('with no usable query it still fills the budget in file order and never returns nothing', () => {
    const k = kb([['a.md', 'A'.repeat(500)], ['b.md', 'B'.repeat(500)], ['c.md', 'C'.repeat(500)]]);
    const s = selectKnowledgeForPrompt(k, '👍', 1100);
    expect(s.includedSections).toBe(2);
    expect(s.text.startsWith('A')).toBe(true);
    expect(s.text).toMatch(/1 knowledge section not shown/);
  });
  it('a single oversized relevant section is cut to the budget rather than dropped', () => {
    const k = kb([['big.md', `Camry accessories list ${'q'.repeat(5000)}`], ['small.md', 'Opening hours 9-6']]);
    const s = selectKnowledgeForPrompt(k, 'camry accessories', 1000);
    expect(s.text).toContain('Camry accessories list');
    expect(s.text).toContain('[... section cut to fit the prompt]');
    expect(s.text.length).toBeLessThan(1200);
  });
});

describe('trimHistoryToBudget', () => {
  it('drops the oldest turns until the text fits, keeps the latest ones, and leaves a short history alone', () => {
    const h = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `turn ${i} ${'m'.repeat(100)}` }));
    expect(trimHistoryToBudget(h, 100_000)).toBe(h);
    const trimmed = trimHistoryToBudget(h, 350);
    expect(trimmed).toHaveLength(4); // keepMin
    expect(trimmed[0]!.content.startsWith('turn 6')).toBe(true);
    expect(trimHistoryToBudget(h, 650).map((t) => t.content.slice(0, 6))).toEqual(['turn 4', 'turn 5', 'turn 6', 'turn 7', 'turn 8', 'turn 9']);
  });
});
