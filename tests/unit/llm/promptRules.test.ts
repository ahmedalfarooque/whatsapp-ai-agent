import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, currentDateTimeIn } from '../../../src/llm/buildSystemPrompt';
import { getDb } from '../../../src/memory/db';

const EMPTY_KNOWLEDGE = { sections: [], asPromptText: '' };

describe('current date and time', () => {
  it('is given in the business timezone so "today" and "now" can be answered', () => {
    const at = new Date('2026-10-09T21:30:00Z'); // 00:30 on Saturday 10 October in Riyadh (UTC+3)
    expect(currentDateTimeIn('Asia/Riyadh', at)).toBe('Saturday 10 October 2026 00:30');
    expect(currentDateTimeIn('UTC', at)).toBe('Friday 9 October 2026 21:30');
  });

  it('an invalid timezone yields nothing rather than a wrong time', () => {
    expect(currentDateTimeIn('Not/AZone', new Date())).toBe('');
  });

  it('appears in the prompt', () => {
    getDb();
    const prompt = buildSystemPrompt(EMPTY_KNOWLEDGE, 'en', new Date('2026-10-09T21:30:00Z'));
    expect(prompt).toMatch(/CURRENT DATE AND TIME: \w+day \d+ \w+ 2026 \d\d:\d\d/);
  });
});

describe('reply rules in the prompt', () => {
  it('carry the quality, honesty and language rules every account shares', () => {
    getDb();
    const prompt = buildSystemPrompt(EMPTY_KNOWLEDGE, undefined);
    for (const rule of [
      'Lead with the answer in the first sentence',
      'Greet only in the first reply',
      'at most ONE follow-up question',
      'the language of the customer\'s latest message',
      'CONTEXT, not a verified fact',
      'marked "NOT VERIFIED"',
      'Never say something was booked, saved, sent or requested unless a tool result says it succeeded',
      'does not confirm a specific item',
      'do not answer "Yes"',
      'is simply not known',
    ]) expect(prompt, rule).toContain(rule);
  });

  it('the menu language never locks the reply language: the latest message decides, and a menu choice only fills a silent message', () => {
    getDb();
    // the customer chose English from the menu but writes Malayalam: the reply is Malayalam
    expect(buildSystemPrompt(EMPTY_KNOWLEDGE, 'en', new Date(), { latestText: 'ഈ കാറിന് ആക്സസറികൾ ഉണ്ടോ?' })).toContain('REPLY LANGUAGE: Malayalam');
    expect(buildSystemPrompt(EMPTY_KNOWLEDGE, 'ar', new Date(), { latestText: 'Combien coûte la teinture des vitres ?' })).toContain('REPLY LANGUAGE: French');
    // a message with no language of its own (a number) falls back to the menu choice
    expect(buildSystemPrompt(EMPTY_KNOWLEDGE, 'ar', new Date(), { latestText: '2' })).toContain('REPLY LANGUAGE: Arabic for this message');
    expect(buildSystemPrompt(EMPTY_KNOWLEDGE)).toContain("REPLY LANGUAGE: the language of the customer's latest message");
    for (const prompt of [buildSystemPrompt(EMPTY_KNOWLEDGE, 'ar'), buildSystemPrompt(EMPTY_KNOWLEDGE, 'en')]) {
      expect(prompt).not.toContain('regardless of the language');
      expect(prompt).toContain('if they switch language, switch with them');
    }
  });

  it('the picture rules every account shares: identify before advising, no invented identification, no unverified compatibility', () => {
    getDb();
    const prompt = buildSystemPrompt(EMPTY_KNOWLEDGE);
    for (const rule of ['PICTURES THE CUSTOMER SENDS', 'Never describe, identify or guess a picture that has no such entry', 'Identify before you advise', 'Never recommend vehicle- or model-specific', 'Never say you checked or verified compatibility', 'do not switch to a different product or model']) expect(prompt, rule).toContain(rule);
  });
});
