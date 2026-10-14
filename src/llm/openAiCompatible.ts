import { env } from '../config/env';
import { fetchWithTimeout } from '../utils/retry';
import { AiCredentialError } from './aiCredentialError';
import { AiResponseError, reasonForHttpStatus } from './aiResponseError';
import type { ChatCompletionResponse, ChatMessage } from './types';
import type { ToolDefinition } from '../tools';

/**
 * ONE request to ONE OpenAI-compatible chat-completions endpoint (OpenRouter, Groq, Google AI Studio, Cerebras, Mistral, a local Ollama…),
 * with a hard timeout and no retry: the router decides what to try next. Every failure is a typed AiResponseError / AiCredentialError that
 * carries safe diagnostics only (category, HTTP status, model, the provider's short message) — never the key, the prompt or customer text.
 * Images and recordings are sent as data URLs / base64 parts and are never logged; this is the only place a request leaves the process.
 */
export interface EndpointRequest {
  baseUrl: string; // e.g. https://openrouter.ai/api/v1 (the "/chat/completions" path is appended)
  apiKey: string | null; // null = no Authorization header (a local runtime)
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition['schema'][];
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
  /** Extra headers (OpenRouter's app attribution). */
  headers?: Record<string, string>;
}

export function messageText(content: unknown): string {
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
export function providerMessageOf(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message;
    return typeof message === 'string' ? message.replace(/\s+/g, ' ').slice(0, 160) : null;
  } catch {
    return body.replace(/\s+/g, ' ').slice(0, 120) || null;
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

export async function completeOnce(request: EndpointRequest): Promise<ChatCompletionResponse> {
  const url = `${request.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
          'Content-Type': 'application/json',
          ...(request.headers ?? {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          ...(request.tools && request.tools.length ? { tools: request.tools } : {}),
          temperature: request.temperature ?? 0.4,
          max_tokens: request.maxTokens ?? 600,
        }),
      },
      Math.max(1000, request.timeoutMs),
    );
  } catch (error) {
    // No answer at all (refused connection, DNS, abort/timeout): the provider or the network, never this model's fault — the error says so.
    const name = (error as Error)?.name ?? 'network error';
    const failure = new AiResponseError('provider_error', null, request.model, name === 'AbortError' ? 'timeout' : name);
    failure.network = true;
    throw failure;
  }
  if (response.status === 401 || response.status === 403) {
    throw new AiCredentialError(`The provider refused the API key (HTTP ${response.status}).`, 'rejected', response.status);
  }
  if (!response.ok) {
    const errorBody = await response.text().catch(() => undefined);
    const retryAfter = Number(response.headers?.get?.('retry-after') ?? '');
    const failure = new AiResponseError(reasonForHttpStatus(response.status), response.status, request.model, providerMessageOf(errorBody));
    if (Number.isFinite(retryAfter) && retryAfter > 0) failure.retryAfterMs = Math.min(retryAfter * 1000, 15 * 60_000);
    throw failure;
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new AiResponseError('malformed_response', response.status, request.model);
  }
  return validateCompletion(parsed, request.model);
}

/** The attribution headers OpenRouter asks apps to send. */
export function openRouterHeaders(): Record<string, string> {
  return {
    ...(env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': env.OPENROUTER_SITE_URL } : {}),
    ...(env.OPENROUTER_APP_NAME ? { 'X-Title': env.OPENROUTER_APP_NAME } : {}),
  };
}
