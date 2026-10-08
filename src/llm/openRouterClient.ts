import { env } from '../config/env';
import { describeCredential, getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { getBusinessSettings } from '../config/businessSettings';
import { logger } from '../logger';
import { fetchWithTimeout, withRetry, HttpError, isRetryableHttpError } from '../utils/retry';
import { chatCompletionMock } from './mockOpenRouterClient';
import { AiCredentialError } from './aiCredentialError';
import type { ChatCompletionResponse, ChatMessage } from './types';
import type { ToolDefinition } from '../tools';

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition['schema'][];
  temperature?: number;
  maxTokens?: number;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const REJECTED_LOG_INTERVAL_MS = 5 * 60_000;
let lastRejectedLogAt = 0;

/** The key to send, or a clear AiCredentialError. An empty, malformed or undecryptable value is never sent to the provider. */
function usableApiKey(): string {
  const diag = describeCredential('OPENROUTER_API_KEY');
  const key = getEffectiveCredential('OPENROUTER_API_KEY');
  if (!key.trim()) {
    throw new AiCredentialError('No OpenRouter API key is available. Enter one in the dashboard (Providers).', 'missing');
  }
  if (!isUsableApiKey(key)) {
    logger.warn({ credential: 'OPENROUTER_API_KEY', source: diag.source, overrideStatus: diag.overrideStatus }, 'the configured OpenRouter key is not a usable key (wrong format or length); it was not sent to the provider');
    throw new AiCredentialError('The configured OpenRouter API key is not a usable key. Enter a valid one in the dashboard (Providers).', 'malformed');
  }
  return key;
}

function noteRejected(status: number): void {
  const now = Date.now();
  if (now - lastRejectedLogAt < REJECTED_LOG_INTERVAL_MS) return;
  lastRejectedLogAt = now;
  const diag = describeCredential('OPENROUTER_API_KEY');
  logger.error({ credential: 'OPENROUTER_API_KEY', source: diag.source, overrideStatus: diag.overrideStatus, httpStatus: status }, 'OpenRouter refused the API key; AI replies fail until a valid key is entered in the dashboard (Providers)');
}

/** Calls OpenRouter's OpenAI-compatible chat completions endpoint with tool-calling support. */
export async function chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  if (env.shouldUseMockProviders) {
    return chatCompletionMock(request.messages);
  }
  return withRetry(
    async () => {
      const apiKey = usableApiKey();
      const response = await fetchWithTimeout(
        OPENROUTER_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': env.OPENROUTER_SITE_URL } : {}),
            ...(env.OPENROUTER_APP_NAME ? { 'X-Title': env.OPENROUTER_APP_NAME } : {}),
          },
          body: JSON.stringify({
            model: getBusinessSettings().openRouterModel,
            messages: request.messages,
            tools: request.tools,
            temperature: request.temperature ?? 0.4,
            max_tokens: request.maxTokens ?? 600,
          }),
        },
        env.OPENROUTER_TIMEOUT_MS,
      );

      if (response.status === 401 || response.status === 403) {
        noteRejected(response.status);
        throw new AiCredentialError(`OpenRouter refused the API key (HTTP ${response.status}). Enter a valid key in the dashboard (Providers).`, 'rejected', response.status);
      }
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
      isRetryable: (error) => !(error instanceof AiCredentialError) && isRetryableHttpError(error),
      onRetry: (error, attempt) => {
        logger.warn({ error, attempt }, 'retrying OpenRouter chat completion');
      },
    },
  );
}
