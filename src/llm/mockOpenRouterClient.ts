import { logger } from '../logger';
import { contentText, type ChatCompletionResponse, type ChatMessage } from './types';

/**
 * Mock LLM provider used whenever env.shouldUseMockProviders is true (i.e.
 * NODE_ENV !== 'production'). Never calls OpenRouter or any external model,
 * and — deliberately — never returns tool_calls, so the agent loop always
 * terminates immediately with a plain deterministic reply. This keeps
 * development safe: even if a developer wires up the real tool handlers
 * against real calendar/whatsapp mocks, the mock LLM itself can never be
 * the thing that triggers a real check_availability/book_appointment call.
 */
export async function chatCompletionMock(
  messages: ChatMessage[],
): Promise<ChatCompletionResponse> {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  // A picture in the last turn is acknowledged, never described: the mock has not seen it and must not pretend to.
  const parts = Array.isArray(lastUser?.content) ? lastUser.content : [];
  const preview = contentText(lastUser?.content ?? '') + (parts.some((p) => p.type === 'image_url') ? ' [image attached — not analysed by the mock]' : '');

  logger.info(
    { preview },
    '[MOCK LLM] returning deterministic development response — no real OpenRouter call made',
  );

  return {
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content:
            `[DEV MODE MOCK REPLY] I received: "${preview}". ` +
            'This is a deterministic development response — no real AI model was called.',
        },
      },
    ],
  };
}
