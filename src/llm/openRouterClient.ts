import { env } from '../config/env';
import { describeCredential, getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { getBusinessSettings } from '../config/businessSettings';
import { logger } from '../logger';
import { fetchWithTimeout, withRetry } from '../utils/retry';
import { chatCompletionMock } from './mockOpenRouterClient';
import { AiCredentialError } from './aiCredentialError';
import { AiResponseError, reasonForHttpStatus } from './aiResponseError';
import type { ChatCompletionResponse, ChatMessage } from './types';
import type { ToolDefinition } from '../tools';

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition['schema'][];
  temperature?: number;
  maxTokens?: number;
  /** Epoch ms after which no new attempt may start (the whole AI loop's time budget). */
  deadline?: number;
  /** Overrides the business's chat model for this one call (the vision step uses the image-capable model). */
  model?: string;
  /** Overrides the per-attempt timeout (ms); still capped by the deadline. */
  timeoutMs?: number;
  /** Fewer retries for a step that has its own fallback (the vision step: one retry on a rate limit / provider error). */
  retries?: number;
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

/** Text of a message whatever shape the provider used: a string, or an array of content parts ({type:'text', text}). */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof (part as { text?: unknown })?.text === 'string' ? (part as { text: string }).text : ''))
      .join('')
      .trim();
  }
  return '';
}

/** The provider's own short explanation of an error (never the request), flattened and truncated for logs and the activity list. */
function providerMessageOf(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const message = (JSON.parse(body) as { error?: { message?: unknown } })?.error?.message;
    return typeof message === 'string' ? message.replace(/\s+/g, ' ').slice(0, 160) : null;
  } catch {
    return null;
  }
}

/**
 * Checks that a provider answer actually contains something to send: at least one choice with a message, and either text or a tool
 * call. An HTTP 200 with an empty message is a FAILED answer, not a successful empty reply. Returns the response with the message text
 * normalised to a plain string.
 */
export function validateCompletion(parsed: unknown, model: string): ChatCompletionResponse {
  const choices = (parsed as { choices?: unknown } | null)?.choices;
  const choice = Array.isArray(choices) ? (choices[0] as { message?: Record<string, unknown> } | undefined) : undefined;
  if (!choice || typeof choice.message !== 'object' || choice.message === null) {
    throw new AiResponseError('malformed_response', 200, model);
  }
  const toolCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
  const text = messageText(choice.message.content);
  if (toolCalls.length === 0 && !text) throw new AiResponseError('empty_response', 200, model);
  choice.message = { ...choice.message, content: text || null };
  return parsed as ChatCompletionResponse;
}

/** Calls OpenRouter's OpenAI-compatible chat completions endpoint with tool-calling support. */
export async function chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  if (env.shouldUseMockProviders) {
    return chatCompletionMock(request.messages);
  }
  // Images are sent as data URLs (the bytes themselves, base64). They are never logged; this is the only place the request leaves the process.
  const model = request.model ?? getBusinessSettings().openRouterModel;
  const perAttemptMs = request.timeoutMs ?? env.OPENROUTER_TIMEOUT_MS;
  // Retries are bounded: at most 2 more attempts for a rate limit or provider failure, and ONE more for an empty answer. A bad model
  // or policy refusal (400-404) is never retried — asking again cannot help and would only cost money.
  let emptyRetries = 0;
  return withRetry(
    async () => {
      const apiKey = usableApiKey();
      let response: Response;
      try {
        response = await fetchWithTimeout(
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
              model,
              messages: request.messages,
              tools: request.tools,
              temperature: request.temperature ?? 0.4,
              max_tokens: request.maxTokens ?? 600,
            }),
          },
          request.deadline ? Math.max(1000, Math.min(perAttemptMs, request.deadline - Date.now())) : perAttemptMs,
        );
      } catch (error) {
        throw new AiResponseError('provider_error', null, model, `${(error as Error)?.name ?? 'network error'}`);
      }

      if (response.status === 401 || response.status === 403) {
        noteRejected(response.status);
        throw new AiCredentialError(`OpenRouter refused the API key (HTTP ${response.status}). Enter a valid key in the dashboard (Providers).`, 'rejected', response.status);
      }
      if (!response.ok) {
        const errorBody = await response.text().catch(() => undefined);
        throw new AiResponseError(reasonForHttpStatus(response.status), response.status, model, providerMessageOf(errorBody));
      }

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new AiResponseError('malformed_response', response.status, model);
      }
      return validateCompletion(parsed, model);
    },
    {
      retries: request.retries ?? 2,
      isRetryable: (error) => {
        if (error instanceof AiCredentialError) return false;
        if (request.deadline && Date.now() + 2000 > request.deadline) return false; // no time left for another attempt
        if (error instanceof AiResponseError) {
          if (error.reason === 'empty_response') return emptyRetries++ < 1;
          return error.reason === 'rate_limited' || error.reason === 'provider_error';
        }
        return false;
      },
      onRetry: (error, attempt) => {
        const e = error as AiResponseError;
        logger.warn({ attempt, reason: e.reason, httpStatus: e.httpStatus, model: e.model }, 'retrying OpenRouter chat completion');
      },
    },
  );
}
