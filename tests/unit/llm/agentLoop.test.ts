import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/llm/openRouterClient', () => ({
  chatCompletion: vi.fn(),
}));
vi.mock('../../../src/tools', () => ({
  toolRegistry: {
    check_availability: {
      schema: { type: 'function', function: { name: 'check_availability' } },
      handler: vi.fn(),
    },
  },
  toolSchemas: [{ type: 'function', function: { name: 'check_availability' } }],
}));

import { chatCompletion } from '../../../src/llm/openRouterClient';
import { toolRegistry } from '../../../src/tools';
import { runAgentLoop } from '../../../src/llm/agentLoop';

function textResponse(content: string) {
  return { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] };
}

function toolCallResponse(toolName: string, args: Record<string, unknown>, id = 'call_1') {
  return {
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

describe('runAgentLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns immediately when the model answers without needing a tool', async () => {
    vi.mocked(chatCompletion).mockResolvedValue(textResponse('Hello, how can I help?') as never);

    const result = await runAgentLoop({ systemPrompt: 'sys', history: [] });

    expect(result.finalText).toBe('Hello, how can I help?');
    expect(chatCompletion).toHaveBeenCalledOnce();
  });

  it('executes a tool call, feeds the result back, then returns the final answer', async () => {
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallResponse('check_availability', { date: '2025-06-10', durationMinutes: 30 }) as never)
      .mockResolvedValueOnce(textResponse('We have a 10am slot free.') as never);

    vi.mocked(toolRegistry.check_availability.handler).mockResolvedValue({
      date: '2025-06-10',
      slots: ['2025-06-10T10:00:00'],
    });

    const result = await runAgentLoop({ systemPrompt: 'sys', history: [] });

    expect(result.finalText).toBe('We have a 10am slot free.');
    expect(toolRegistry.check_availability.handler).toHaveBeenCalledWith({
      date: '2025-06-10',
      durationMinutes: 30,
    });
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(result.generatedMessages.some((m) => m.role === 'tool')).toBe(true);
  });

  it('handles an unknown tool name from the model without crashing', async () => {
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallResponse('delete_database', {}) as never)
      .mockResolvedValueOnce(textResponse('done') as never);

    const result = await runAgentLoop({ systemPrompt: 'sys', history: [] });
    expect(result.finalText).toBe('done');
  });

  it('handles a tool handler throwing without crashing the loop', async () => {
    vi.mocked(chatCompletion)
      .mockResolvedValueOnce(toolCallResponse('check_availability', { date: '2025-06-10' }) as never)
      .mockResolvedValueOnce(textResponse('ok') as never);
    vi.mocked(toolRegistry.check_availability.handler).mockRejectedValue(new Error('boom'));

    const result = await runAgentLoop({ systemPrompt: 'sys', history: [] });
    expect(result.finalText).toBe('ok');
  });

  it('stops after maxToolRounds and returns a safe fallback instead of looping forever', async () => {
    vi.mocked(chatCompletion).mockResolvedValue(
      toolCallResponse('check_availability', { date: '2025-06-10' }) as never,
    );
    vi.mocked(toolRegistry.check_availability.handler).mockResolvedValue({ slots: [] });

    const result = await runAgentLoop({ systemPrompt: 'sys', history: [], maxToolRounds: 2 });

    expect(chatCompletion).toHaveBeenCalledTimes(2);
    expect(result.finalText).toMatch(/get back to you|contact us/i);
  });
});
