import { beforeAll, describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../../../src/llm/buildSystemPrompt';
import { buildLocalPrompt } from '../../../src/llm/localPrompt';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { updateBusinessSettings } from '../../../src/config/businessSettings';

/**
 * The lean prompt for a slow local model: much smaller than the full one, still carrying identity, facts, hours, the knowledge relevant to
 * the customer's message and the honesty rules — and no tool, media or catalogue instructions a text-only answer cannot use.
 */
const filler = (n: number) => Array.from({ length: n }, (_, i) => `Filler paragraph ${i}: general company policy text that is not about the question at all. `.repeat(3)).join('\n');
const KB = {
  sections: [
    { fileName: 'services.md', content: '# Services\nWe offer ceramic window tinting for sedans and SUVs, paint protection and car audio installation.' },
    { fileName: 'policies.md', content: `# Policies\n${filler(60)}` },
    { fileName: 'prices.md', content: '# Prices\nCeramic tint starts at 450 SAR for a sedan.' },
  ],
  asPromptText: '',
};
KB.asPromptText = KB.sections.map((s) => s.content).join('\n\n');
let ACC: number;

beforeAll(() => {
  getDb();
  ACC = createAccount({ name: 'Pearl Tint' }).id;
  runWithAccount(ACC, () => updateBusinessSettings({ businessTimezone: 'Asia/Riyadh', businessHoursStart: '09:00', businessHoursEnd: '18:00', businessDays: '1,2,3,4,5,6,7', contactPhone: '+966112223344', businessCategory: 'Car care', descriptionEn: 'Window tinting and car audio in Riyadh.' }, ACC));
});

describe('lean local prompt', () => {
  it('is a small fraction of the full prompt but keeps the business facts, the status, the relevant knowledge and the honesty rules', () => {
    const now = new Date('2026-10-08T07:00:00Z'); // Thursday 10:00 Riyadh: open
    const lean = runWithAccount(ACC, () => buildLocalPrompt(KB, 'en', { latestText: 'How much is ceramic tint for an SUV?', now }));
    const full = runWithAccount(ACC, () => buildSystemPrompt(KB, 'en', now, { latestText: 'How much is ceramic tint for an SUV?' } as never));
    expect(lean.length).toBeLessThan(full.length / 2);
    expect(lean.length).toBeLessThan(4500);
    expect(lean).toContain('Pearl Tint');
    expect(lean).toContain('+966112223344');
    expect(lean).toMatch(/Right now the business is OPEN/);
    expect(lean).toContain('Ceramic tint starts at 450 SAR'); // the knowledge relevant to THIS message
    expect(lean).toMatch(/Never guess/);
    expect(lean).toMatch(/only ones you may mention|Current offers: none/);
    expect(lean).not.toMatch(/search_catalogues|book_appointment|check_availability|IMAGE_RULES|tool/i); // no tool / catalogue / media instructions
  });

  it('the knowledge it carries follows the question, not the file order', () => {
    const lean = runWithAccount(ACC, () => buildLocalPrompt(KB, 'en', { latestText: 'what services do you offer: tinting, audio?', knowledgeChars: 500 }));
    expect(lean).toContain('ceramic window tinting');
    expect(lean.length).toBeLessThan(3500);
  });

  it('never invents offers: with none configured it says so, and a closed business is stated as closed with the next opening', () => {
    const closed = runWithAccount(ACC, () => buildLocalPrompt(KB, 'ar', { latestText: 'من أنتم؟', now: new Date('2026-10-07T20:00:00Z') })); // 23:00 Riyadh
    expect(closed).toMatch(/Current offers: none/);
    expect(closed).toMatch(/Right now the business is CLOSED; it reopens/);
    expect(closed).toMatch(/REPLY LANGUAGE/);
  });

  it('answers with the account\'s own identity: another business\'s name and phone never appear', () => {
    const other = createAccount({ name: 'Other Bakery' }).id;
    runWithAccount(other, () => updateBusinessSettings({ contactPhone: '+966500009999' }, other));
    const lean = runWithAccount(ACC, () => buildLocalPrompt(KB, 'en', { latestText: 'Who are you?' }));
    expect(lean).not.toContain('Other Bakery');
    expect(lean).not.toContain('+966500009999');
  });
});
