import { describe, expect, it, beforeEach } from 'vitest';
import { currentPromptScale, parsePromptCap, rememberPromptScale, resetPromptScalesForTests, scaleForCap } from '../../../src/llm/promptCap';

describe('provider prompt-token cap', () => {
  beforeEach(() => resetPromptScalesForTests());

  it('reads both numbers from the production 402 message', () => {
    expect(parsePromptCap('Prompt tokens limit exceeded: 6666 > 6196. To increase, visit https://openrouter.ai/settings/credits')).toEqual({ used: 6666, cap: 6196 });
  });

  it('ignores other provider messages and nonsensical numbers', () => {
    expect(parsePromptCap('Insufficient credits')).toBeNull();
    expect(parsePromptCap(null)).toBeNull();
    expect(parsePromptCap('Prompt tokens limit exceeded: 100 > 200')).toBeNull();
  });

  it('shrinks to about 70% of the cap, never below the floor and never above 0.9', () => {
    expect(scaleForCap({ used: 6666, cap: 6196 })).toBeCloseTo(0.651, 2);
    expect(scaleForCap({ used: 20000, cap: 1000 })).toBe(0.1);
    expect(scaleForCap({ used: 4000, cap: 6200 })).toBe(0.9);
  });

  it('remembers the scale per account for 30 minutes, then forgets it', () => {
    const t0 = 1_000_000;
    expect(currentPromptScale(1, t0)).toBe(1);
    rememberPromptScale(1, 0.5, t0);
    expect(currentPromptScale(1, t0 + 60_000)).toBe(0.5);
    expect(currentPromptScale(2, t0 + 60_000)).toBe(1);
    expect(currentPromptScale(1, t0 + 31 * 60_000)).toBe(1);
  });
});
