import { describe, it, expect } from 'vitest';
import { chatCompletionMock } from '../../../src/llm/mockOpenRouterClient';

describe('LLM mock provider', () => {
  it('returns a deterministic assistant reply and never requests a tool call', async () => {
    const result = await chatCompletionMock([{ role: 'user', content: 'Hi there' }]);

    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].finish_reason).toBe('stop');
    expect(result.choices[0].message.tool_calls).toBeUndefined();
    expect(result.choices[0].message.content).toContain('Hi there');
    expect(result.choices[0].message.content).toContain('DEV MODE MOCK REPLY');
  });

  it('handles empty/no user message without throwing', async () => {
    const result = await chatCompletionMock([]);
    expect(result.choices[0].message.content).toContain('DEV MODE MOCK REPLY');
  });
});
