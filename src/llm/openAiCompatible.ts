import { env } from '../config/env';
import { fetchWithTimeout } from '../utils/retry';
import { AiCredentialError } from './aiCredentialError';
import { AiResponseError, reasonForHttpStatus } from './aiResponseError';
import type { ChatCompletionResponse, ChatMessage } from './types';
import type { ToolDefinition } from '../tools';

/**
 * ONE request to ONE OpenAI-compatible chat-completions endpoint (OpenRouter, Groq, Google AI Studio, Cerebras, Mistral…),
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
  const body = parsed as { choices?: unknown; error?: unknown } | null;
  const choices = body?.choices;
  const choice = Array.isArray(choices) ? (choices[0] as { message?: Record<string, unknown>; finish_reason?: unknown } | undefined) : undefined;
  if (!choice || typeof choice.message !== 'object' || choice.message === null) {
    // Some providers answer HTTP 200 with the failure INSIDE the body (`{ "error": { "code": 429, "message": … } }`): that is the provider's real error,
    // not an unreadable answer, and the router must classify it as such (rate limit, quota, outage…) instead of hiding it as "malformed".
    const inner = body && typeof body.error === 'object' && body.error ? (body.error as { code?: unknown; message?: unknown }) : null;
    if (inner) {
      const code = Number(inner.code);
      const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : null;
      const message = typeof inner.message === 'string' ? inner.message.replace(/\s+/g, ' ').slice(0, 160) : 'the provider reported an error inside a successful response';
      throw new AiResponseError(status ? reasonForHttpStatus(status) : 'provider_error', status ?? 200, model, message);
    }
    // Names only, never values: which top-level fields did arrive.
    throw new AiResponseError('malformed_response', 200, model, `no choices in the answer (fields: ${Object.keys(body && typeof body === 'object' ? body : {}).slice(0, 6).join(', ') || 'none'})`);
  }
  const toolCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
  const text = messageText(choice.message.content);
  if (toolCalls.length === 0 && !text) {
    // WHY the answer is empty is recorded (finish reason; whether the model spent its tokens on hidden reasoning), so a token limit, a filter and a
    // provider fault are told apart in the routing history. The answer is still a failure: nothing is invented.
    const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason.slice(0, 30) : 'none';
    const reasoning = typeof choice.message.reasoning === 'string' ? choice.message.reasoning.trim().length > 0 : Array.isArray(choice.message.reasoning_details) && choice.message.reasoning_details.length > 0;
    throw new AiResponseError('empty_response', 200, model, `empty answer; finish_reason=${finish}${reasoning ? '; reasoning text present but no answer (token limit spent on reasoning)' : ''}`);
  }
  choice.message = { ...choice.message, content: text || null };
  return parsed as ChatCompletionResponse;
}

/**
 * Milliseconds until the provider says the exhausted allowance resets, from `X-RateLimit-Reset` (epoch milliseconds or seconds) given as a header
 * or inside `error.metadata.headers`. Only a believable value is used: between one second and 25 hours ahead; anything else is ignored.
 */
export function quotaResetDelayMs(headerValue: string | null, errorBody: string | undefined, now: number = Date.now()): number | null {
  const candidates: unknown[] = [headerValue];
  try {
    const meta = (JSON.parse(errorBody ?? '{}') as { error?: { metadata?: { headers?: Record<string, unknown> } } }).error?.metadata?.headers;
    if (meta) for (const [k, v] of Object.entries(meta)) if (k.toLowerCase() === 'x-ratelimit-reset') candidates.push(v);
  } catch { /* not JSON */ }
  for (const raw of candidates) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) continue;
    const epochMs = n > 1e12 ? n : n > 1e9 ? n * 1000 : null;
    if (epochMs === null) continue;
    const delta = epochMs - now;
    if (delta >= 1000 && delta <= 25 * 3_600_000) return delta;
  }
  return null;
}

const MAX_STATED_WAIT_MS = 25 * 3_600_000;

/** "1h2m3.5s", "7m12s", "34s", "250ms" → milliseconds (null when the text holds no duration). */
export function parseDurationMs(text: string): number | null {
  let total = 0;
  let found = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)(?![a-z])/gi)) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    total += unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000;
    found = true;
  }
  return found ? Math.round(total) : null;
}

/**
 * When the provider itself says the limit lifts, in milliseconds from now — and ONLY then (null = it did not say; nothing is invented). Read, in the provider's own
 * words: `Retry-After` (seconds or an HTTP date), `retry-after-ms`, `X-RateLimit-Reset` (header or error metadata, epoch), and the wording "Please try again in 6m43.2s" that
 * OpenAI-protocol providers put in the error body. Several statements: the longest wins. Only believable values count: between one second and 25 hours.
 */
export function statedRetryDelayMs(headers: Headers | undefined, errorBody: string | undefined, now: number = Date.now()): number | null {
  const found: number[] = [];
  const add = (ms: number | null): void => { if (ms !== null && Number.isFinite(ms) && ms >= 1000) found.push(Math.min(ms, MAX_STATED_WAIT_MS)); };
  const afterMs = Number(headers?.get?.('retry-after-ms') ?? '');
  if (Number.isFinite(afterMs) && afterMs > 0) add(afterMs);
  const retryAfter = headers?.get?.('retry-after') ?? '';
  if (retryAfter.trim()) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) add(seconds * 1000);
    else { const at = Date.parse(retryAfter); if (Number.isFinite(at)) add(at - now); }
  }
  add(quotaResetDelayMs(headers?.get?.('x-ratelimit-reset') ?? null, errorBody, now));
  const wording = /(?:try again|retry)\s+(?:in|after)\s+([0-9hms.\s]{2,24})/i.exec(providerMessageOf(errorBody) ?? '');
  if (wording) add(parseDurationMs(wording[1]!));
  return found.length ? Math.max(...found) : null;
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
    const failure = new AiResponseError(reasonForHttpStatus(response.status), response.status, request.model, providerMessageOf(errorBody));
    // Whatever reset time the provider STATES (Retry-After, X-RateLimit-Reset, "try again in …") lets the route rest exactly until the limit lifts instead of guessing.
    const stated = statedRetryDelayMs(response.headers, errorBody);
    if (stated) failure.retryAfterMs = stated;
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
