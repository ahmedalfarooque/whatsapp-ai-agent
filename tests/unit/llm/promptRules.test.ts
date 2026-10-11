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
    ]) expect(prompt, rule).toContain(rule);
  });

  it('a set language is an instruction; no language leaves the "reply in the customer\'s language" rule', () => {
    getDb();
    expect(buildSystemPrompt(EMPTY_KNOWLEDGE, 'ar')).toContain('Always reply in Arabic');
    expect(buildSystemPrompt(EMPTY_KNOWLEDGE, 'en')).toContain('Always reply in English');
    expect(buildSystemPrompt(EMPTY_KNOWLEDGE)).not.toContain('Always reply in');
  });
});
