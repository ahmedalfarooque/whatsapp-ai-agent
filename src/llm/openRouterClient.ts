import { env } from '../config/env';
import { logger } from '../logger';
import { fetchWithTimeout, withRetry, HttpError, isRetryableHttpError } from '../utils/retry';
import type { ChatCompletionResponse, ChatMessage } from './types';
import type { ToolDefinition } from '../tools';

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition['schema'][];
  temperature?: number;
  maxTokens?: number;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Calls OpenRouter's OpenAI-compatible chat completions endpoint with tool-calling support. */
export async function chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  return withRetry(
    async () => {
      const response = await fetchWithTimeout(
        OPENROUTER_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            ...(env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': env.OPENROUTER_SITE_URL } : {}),
            ...(env.OPENROUTER_APP_NAME ? { 'X-Title': env.OPENROUTER_APP_NAME } : {}),
          },
          body: JSON.stringify({
            model: env.OPENROUTER_MODEL,
            messages: request.messages,
            tools: request.tools,
            temperature: request.temperature ?? 0.4,
            max_tokens: request.maxTokens ?? 600,
          }),
        },
        env.OPENROUTER_TIMEOUT_MS,
      );

      if (!response.ok) {
        const errorBody = await response.text().catch(() => undefined);
        throw new HttpError(`OpenRouter API error: ${response.status}`, response.status, errorBody);
      }

      const parsed = (await response.json()) as ChatCompletionResponse;
      if (!parsed.choices || parsed.choices.length === 0) {
        throw new Error('OpenRouter response contained no choices');
      }
      return parsed;
    },
    {
      retries: 2,
      isRetryable: isRetryableHttpError,
      onRetry: (error, attempt) => {
        logger.warn({ error, attempt }, 'retrying OpenRouter chat completion');
      },
    },
  );
}
