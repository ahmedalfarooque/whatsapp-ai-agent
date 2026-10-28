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
  /** The name of the completion-limit field: Groq documents `max_completion_tokens` (`max_tokens` is deprecated there); everyone else uses `max_tokens`. */
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
  /** OpenAI's current models accept only the default temperature; sending one is a 400. True = leave the field out. */
  omitTemperature?: boolean;
  timeoutMs: number;
  /** Extra headers (OpenRouter's app attribution). */
  headers?: Record<string, string>;
}

export function describeNetworkFailure(error: unknown): string {
  const name = (error as Error)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  const code = String(((error as { cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code ?? '')).toUpperCase();
  const text = `${(error as Error)?.message ?? ''} ${(error as { cause?: { message?: unknown } })?.cause?.message ?? ''}`;
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(text)) return 'connection refused (nothing is listening at the provider address)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the provider address could not be resolved (DNS)';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'connection reset by the provider';
  if (/CERT|SSL|TLS/.test(code)) return 'TLS error while connecting to the provider';
  return 'network error (no answer from the provider)';
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

/**
 * A gateway (OmniRoute and similar) that tried several upstreams answers ONE 502 listing them all:
 * "<model>: <kind> — [<status>]: <text> (HTTP <status>); … (+N more)". The first upstream's wording alone reads as the whole story, so the list is summarised
 * by CAUSE instead (never the provider's text, so nothing from it can leak). null when the message is not such a list.
 */
export const GATEWAY_SUMMARY_PREFIX = 'gateway up, no upstream answered';
export function summarizeGatewayFailure(message: string): string | null {
  const segments = [...message.matchAll(/—\s*\[(\d{3})\]:?\s*([^;]*)/g)];
  if (segments.length === 0) return null;
  const counts = { quota: 0, key: 0, model: 0, timeout: 0, other: 0 };
  for (const segment of segments) {
    const code = Number(segment[1] ?? 0);
    const text = segment[2] ?? '';
    if (code === 429) counts.quota++;
    else if (code === 401 || code === 402 || code === 403) counts.key++;
    else if (/unavailable|not found|no such model|does not exist/i.test(text)) counts.model++;
    else if (code === 408 || code === 504 || /timeout|timed out/i.test(text)) counts.timeout++;
    else counts.other++;
  }
  const more = /\(\+(\d+) more\)/.exec(message);
  const parts = [
    counts.quota ? `quota/rate-limit ×${counts.quota}` : '', counts.key ? `needs key ×${counts.key}` : '', counts.model ? `model unavailable ×${counts.model}` : '',
    counts.timeout ? `timed out ×${counts.timeout}` : '', counts.other ? `other ×${counts.other}` : '',
  ].filter(Boolean);
  return `${GATEWAY_SUMMARY_PREFIX}: ${parts.join(', ')}${more ? ` (+${more[1]} more)` : ''}`;
}

/** The provider's own short explanation of an error (never the request), flattened and truncated for logs and the activity list. */
export function providerMessageOf(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message;
    return typeof message === 'string' ? (summarizeGatewayFailure(message) ?? message.replace(/\s+/g, ' ').slice(0, 160)) : null;
  } catch {
    return body.replace(/\s+/g, ' ').slice(0, 120) || null;
  }
}

/**
 * "Request too large … on tokens per minute (TPM): Limit 8000, Requested 9234": the request alone is bigger than the free tier's per-minute token limit. Read from the FULL error
 * message (the stored one is shortened), only when the provider says the request is too large — a cumulative rate limit ("Used 7000, Requested 2000") is a 429 and handled as such.
 */
export function parseTokenLimit(errorBody: string | undefined, status: number): { limit: number; requested: number } | null {
  if (!errorBody) return null;
  let message = errorBody;
  try { const parsed = JSON.parse(errorBody) as { error?: { message?: unknown } | string }; const m = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message; if (typeof m === 'string') message = m; } catch { /* plain text */ }
  if (status !== 413 && !/request too large/i.test(message)) return null;
  const hit = /Limit\s+(\d+)\D{1,40}?Requested\s+(\d+)/i.exec(message);
  return hit ? { limit: Number(hit[1]), requested: Number(hit[2]) } : null;
}

/**
 * Checks that a provider answer actually contains something to send: at least one choice with a message, and either text or a tool
 * call. An HTTP 200 with an empty message is a FAILED answer, not a successful empty reply. Returns the response with the message text
 * normalised to a plain string.
 */
/** The failure a provider reports INSIDE an HTTP 200 body (`{ "error": { "code": 429, "message": … } }` or `{ "error": "…" }`), or null. */
function embeddedError(body: { error?: unknown } | null): { code?: unknown; message?: unknown } | null {
  const e = body?.error;
  if (e && typeof e === 'object') return e as { code?: unknown; message?: unknown };
  if (typeof e === 'string' && e.trim()) return { message: e };
  return null;
}

/** Throws the provider's real error for a failure that arrived with HTTP 200: a rejected key is a credential error, everything else keeps the provider's own class (rate limit, quota, outage…). */
function throwEmbedded(inner: { code?: unknown; message?: unknown }, model: string): never {
  const code = Number(inner.code);
  const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : null;
  if (status === 401 || status === 403) throw new AiCredentialError(`The provider refused the API key (HTTP ${status}).`, 'rejected', status);
  const message = typeof inner.message === 'string' ? inner.message.replace(/\s+/g, ' ').slice(0, 160) : 'the provider reported an error inside a successful response';
  throw new AiResponseError(status ? reasonForHttpStatus(status) : 'provider_error', status ?? 200, model, message);
}

export function validateCompletion(parsed: unknown, model: string): ChatCompletionResponse {
  const body = parsed as { choices?: unknown; error?: unknown } | null;
  const choices = body?.choices;
  const choice = Array.isArray(choices) ? (choices[0] as { message?: Record<string, unknown>; finish_reason?: unknown } | undefined) : undefined;
  const inner = embeddedError(body);
  // HTTP 200 alone is not an answer. A body that carries an error is a failed inference — also when a (partial or empty) choice came with it: OpenRouter reports a
  // failure after the first tokens as finish_reason "error" with the error object next to the choice.
  if (inner && (!choice || typeof choice.message !== 'object' || choice.message === null || choice.finish_reason === 'error' || (!messageText(choice.message.content) && !(Array.isArray(choice.message.tool_calls) && choice.message.tool_calls.length)))) throwEmbedded(inner, model);
  if (!choice || typeof choice.message !== 'object' || choice.message === null) {
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

/** Whitespace, a byte-order mark and SSE comment lines (": OPENROUTER PROCESSING") that gateways send ahead of the real body are not part of the answer. */
export function stripKeepAlive(raw: string): string {
  let text = raw.replace(/^\uFEFF/, '');
  for (;;) {
    const next = text.replace(/^\s*:[^\n]*(\n|$)/, '');
    if (next === text) break;
    text = next;
  }
  return text.trim();
}

/** A server-sent-event body (`data: {...}` chunks) folded into the one completion it describes — for gateways that stream although a plain answer was asked for. Null when it holds no chunk. */
export function completionFromEventStream(text: string): unknown | null {
  let content = '';
  let reasoning = '';
  let finish: string | null = null;
  let error: unknown = null;
  let sawChunk = false;
  const calls: Array<{ id?: string; type: string; function: { name: string; arguments: string } }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let chunk: { error?: unknown; choices?: Array<{ delta?: Record<string, unknown>; message?: Record<string, unknown>; finish_reason?: string | null }> };
    try { chunk = JSON.parse(data); } catch { continue; }
    sawChunk = true;
    if (chunk.error) error = chunk.error;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const part = choice.delta ?? choice.message ?? {};
    if (typeof part.content === 'string') content += part.content;
    if (typeof part.reasoning === 'string') reasoning += part.reasoning;
    if (Array.isArray(part.tool_calls)) {
      for (const raw of part.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
        const at = Number.isInteger(raw.index) ? (raw.index as number) : 0;
        const call = (calls[at] ??= { type: 'function', function: { name: '', arguments: '' } });
        if (raw.id) call.id = raw.id;
        if (raw.function?.name) call.function.name += raw.function.name;
        if (raw.function?.arguments) call.function.arguments += raw.function.arguments;
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  if (!sawChunk) return null;
  const message: Record<string, unknown> = { role: 'assistant', content };
  if (reasoning) message.reasoning = reasoning;
  const toolCalls = calls.filter(Boolean);
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { ...(error ? { error } : {}), choices: [{ index: 0, finish_reason: finish ?? 'stop', message }] };
}

/** What a 200 body was, without its content: used only to say WHY it could not be read. */
const bodyKind = (text: string): string => (text.length === 0 ? 'empty' : /^<(!doctype|html|\?xml)/i.test(text) ? 'html' : 'text');

/** Reads a provider's HTTP 200 body: JSON, JSON behind keep-alive lines, or an event stream; anything else is a malformed answer that says what it was (never its content). */
export function parseCompletionBody(raw: string, model: string, status: number): unknown {
  const text = stripKeepAlive(raw);
  try { return JSON.parse(text); } catch { /* not plain JSON */ }
  const streamed = completionFromEventStream(text);
  if (streamed) return streamed;
  throw new AiResponseError('malformed_response', status, model, `the answer body was not JSON (${bodyKind(text)}, ${raw.length} bytes)`);
}

export async function completeOnce(request: EndpointRequest): Promise<ChatCompletionResponse> {
  const url = `${request.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        redirect: 'error', // a provider address never bounces the API key to another host
        headers: {
          ...(request.apiKey ? { Authorization: `Bearer ${request.apiKey}` } : {}),
          'Content-Type': 'application/json',
          ...(request.headers ?? {}),
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          ...(request.tools && request.tools.length ? { tools: request.tools } : {}),
          ...(request.omitTemperature ? {} : { temperature: request.temperature ?? 0.4 }),
          [request.tokenParam ?? 'max_tokens']: request.maxTokens ?? 600,
        }),
      },
      Math.max(1000, request.timeoutMs),
    );
  } catch (error) {
    // No answer at all (refused connection, DNS, abort/timeout): the provider or the network, never this model's fault — the error says so.
    const failure = new AiResponseError('provider_error', null, request.model, describeNetworkFailure(error));
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
    failure.tokenLimit = parseTokenLimit(errorBody, response.status);
    throw failure;
  }
  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch {
    throw new AiResponseError('malformed_response', response.status, request.model, 'the answer body could not be read');
  }
  return validateCompletion(parseCompletionBody(rawBody, request.model, response.status), request.model);
}

/** The attribution headers OpenRouter asks apps to send. */
export function openRouterHeaders(): Record<string, string> {
  return {
    ...(env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': env.OPENROUTER_SITE_URL } : {}),
    ...(env.OPENROUTER_APP_NAME ? { 'X-Title': env.OPENROUTER_APP_NAME } : {}),
  };
}
