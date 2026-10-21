import { fetchWithTimeout } from '../../utils/retry';
import { AiCredentialError } from '../aiCredentialError';
import { AiResponseError } from '../aiResponseError';
import { providerMessageOf, statedRetryDelayMs } from '../openAiCompatible';
import type { ChatCompletionResponse, ChatMessage, ContentPart, ToolCall } from '../types';
import type { AdapterCompleteRequest, ProviderAdapter } from './types';

/**
 * Google AI Studio / Gemini API, its own native contract (https://ai.google.dev/api):
 *   POST {base}/models/{model}:generateContent        header `x-goog-api-key: <key>`
 *   body  { contents:[{role:"user"|"model", parts:[{text}|{inlineData}|{functionCall}|{functionResponse}]}], systemInstruction:{parts:[{text}]},
 *           generationConfig:{temperature,maxOutputTokens}, tools:[{functionDeclarations:[{name,description,parameters}]}] }
 *   answer { candidates:[{content:{parts:[{text}|{functionCall:{name,args}}]}, finishReason}], promptFeedback }
 *   GET  {base}/models                                 → { models:[{ name:"models/<id>", displayName, supportedGenerationMethods, inputTokenLimit }] }
 *   errors { error:{ code, message, status } } with status INVALID_ARGUMENT / PERMISSION_DENIED / NOT_FOUND / RESOURCE_EXHAUSTED / UNAVAILABLE …
 * The agent loop speaks the OpenAI message shape, so this adapter translates both ways; the router never sees a Gemini structure.
 */
const BASE_DEFAULT = 'https://generativelanguage.googleapis.com/v1beta';
export const THINKING_HEADROOM_TOKENS = 1024;

// Gemini accepts only a subset of JSON Schema for tool parameters: unknown keywords make the request fail, so they are dropped.
const UNSUPPORTED_SCHEMA_KEYS = new Set(['additionalProperties', '$schema', 'default', 'examples', 'title', '$id', 'definitions', '$defs']);
function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (schema && typeof schema === 'object') return Object.fromEntries(Object.entries(schema as Record<string, unknown>).filter(([k]) => !UNSUPPORTED_SCHEMA_KEYS.has(k)).map(([k, v]) => [k, cleanSchema(v)]));
  return schema;
}

type Part = Record<string, unknown>;

function partsOf(content: ChatMessage['content']): Part[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Part[] = [];
  for (const p of content as ContentPart[]) {
    if (p.type === 'text') { if (p.text) out.push({ text: p.text }); continue; }
    if (p.type === 'image_url') {
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(p.image_url.url);
      if (m) out.push({ inlineData: { mimeType: m[1], data: m[2] } });
      continue; // a remote image URL is never fetched on the model's behalf
    }
    if (p.type === 'input_audio') out.push({ inlineData: { mimeType: `audio/${p.input_audio.format}`, data: p.input_audio.data } });
  }
  return out;
}

/** OpenAI-shaped history → Gemini `contents` + `systemInstruction`. Tool results become functionResponse parts under the function's own name. */
export function toGeminiRequest(request: AdapterCompleteRequest): Record<string, unknown> {
  const system: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: Part[] }> = [];
  const nameById = new Map<string, string>();
  for (const m of request.messages) {
    if (m.role === 'system') { const t = typeof m.content === 'string' ? m.content : partsOf(m.content).map((p) => String(p.text ?? '')).join(''); if (t) system.push(t); continue; }
    if (m.role === 'assistant') {
      const parts = partsOf(m.content);
      for (const call of m.tool_calls ?? []) {
        nameById.set(call.id, call.function.name);
        let args: unknown = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
        parts.push({ functionCall: { name: call.function.name, args } });
      }
      if (parts.length) contents.push({ role: 'model', parts });
      continue;
    }
    if (m.role === 'tool') {
      const name = (m.tool_call_id && nameById.get(m.tool_call_id)) || m.name || 'tool';
      let response: unknown = { result: typeof m.content === 'string' ? m.content : '' };
      if (typeof m.content === 'string') { try { const parsed = JSON.parse(m.content); response = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { result: parsed }; } catch { response = { result: m.content }; } }
      const last = contents[contents.length - 1];
      const part = { functionResponse: { name, response } };
      if (last && last.role === 'user' && last.parts.every((p) => 'functionResponse' in p)) last.parts.push(part); else contents.push({ role: 'user', parts: [part] });
      continue;
    }
    const parts = partsOf(m.content);
    if (parts.length) contents.push({ role: 'user', parts });
  }
  return {
    contents,
    ...(system.length ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } } : {}),
    // Gemini's "thinking" models count their hidden thoughts against maxOutputTokens: with the requested limit alone they can spend it all on thinking and return an
    // empty or cut-off answer (verified live: gemini-3.8-flash with 16 tokens → finishReason MAX_TOKENS, 11 thought tokens, answer ":"). The limit therefore has
    // headroom for the thoughts; the reply itself stays short because the prompt asks for short replies.
    generationConfig: { temperature: request.temperature ?? 0.4, maxOutputTokens: Math.min((request.maxTokens ?? 600) + THINKING_HEADROOM_TOKENS, 8192) },
    ...(request.tools && request.tools.length ? { tools: [{ functionDeclarations: request.tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: cleanSchema(t.function.parameters) })) }] } : {}),
  };
}

/** Gemini answer → the OpenAI-shaped completion the rest of the application reads. An answer with neither text nor a function call is a failure. */
export function fromGeminiResponse(parsed: unknown, model: string): ChatCompletionResponse {
  const body = parsed as { candidates?: Array<{ content?: { parts?: Part[] }; finishReason?: string }>; promptFeedback?: { blockReason?: string } } | null;
  const candidate = body?.candidates?.[0];
  if (!candidate) {
    // A prompt blocked by the provider's own safety system is a rejection of THIS request, not an outage.
    if (body?.promptFeedback?.blockReason) throw new AiResponseError('model_unavailable', 200, model, `blocked by the provider's safety policy (${String(body.promptFeedback.blockReason).slice(0, 40)})`);
    throw new AiResponseError('malformed_response', 200, model);
  }
  const parts = candidate.content?.parts ?? [];
  const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('').trim();
  const toolCalls: ToolCall[] = [];
  parts.forEach((p, i) => {
    const fc = p.functionCall as { name?: unknown; args?: unknown } | undefined;
    if (fc && typeof fc.name === 'string') toolCalls.push({ id: `call_${i}_${fc.name}`.slice(0, 64), type: 'function', function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) } });
  });
  if (!text && toolCalls.length === 0) throw new AiResponseError('empty_response', 200, model, `empty answer; finishReason=${String(candidate.finishReason ?? 'none').slice(0, 30)}`);
  return { choices: [{ index: 0, finish_reason: toolCalls.length ? 'tool_calls' : candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop', message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }] };
}

/** Gemini's documented error statuses → the normalised error the router understands. */
/** Quota ids and the retry delay from a Google error body (`error.details`); empty when the body does not carry them. */
export function quotaInfo(bodyText: string | undefined): { quotaIds: string[]; retryDelayMs: number | null } {
  const out: { quotaIds: string[]; retryDelayMs: number | null } = { quotaIds: [], retryDelayMs: null };
  let details: unknown;
  try { details = (JSON.parse(bodyText ?? '{}') as { error?: { details?: unknown } }).error?.details; } catch { return out; }
  if (!Array.isArray(details)) return out;
  for (const d of details as Array<Record<string, unknown>>) {
    const type = String(d?.['@type'] ?? '');
    if (/QuotaFailure$/.test(type) && Array.isArray(d.violations)) {
      for (const v of d.violations as Array<Record<string, unknown>>) if (typeof v?.quotaId === 'string') out.quotaIds.push(v.quotaId);
    }
    if (/RetryInfo$/.test(type) && typeof d.retryDelay === 'string') {
      const seconds = Number.parseFloat(d.retryDelay); // "34s" or "34.5s"
      if (Number.isFinite(seconds) && seconds >= 0) out.retryDelayMs = Math.round(seconds * 1000);
    }
  }
  return out;
}

/** Milliseconds until the next midnight in Pacific time, when Google resets the daily free-tier quotas (at least one minute, so a reset edge never spins). */
export function pacificMidnightDelayMs(now: number = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(now));
  const num = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsed = (((num('hour') % 24) * 60 + num('minute')) * 60 + num('second')) * 1000; // some engines print midnight as "24"
  return Math.max(60_000, 24 * 3600_000 - elapsed);
}

function failureFor(status: number, bodyText: string | undefined, model: string, headers?: Headers): AiResponseError | AiCredentialError {
  const retryAfter = (statedRetryDelayMs(headers, undefined) ?? 0) / 1000;
  let google = '';
  try { google = String((JSON.parse(bodyText ?? '{}') as { error?: { status?: unknown } }).error?.status ?? ''); } catch { /* not JSON */ }
  const message = providerMessageOf(bodyText);
  const lower = (message ?? '').toLowerCase();
  // A bad key is reported as HTTP 400 INVALID_ARGUMENT ("API key not valid") or 401/403.
  if (status === 401 || status === 403 || google === 'PERMISSION_DENIED' || google === 'UNAUTHENTICATED' || /api key not valid|api_key_invalid|api key expired/.test(lower)) {
    return new AiCredentialError(`The provider refused the API key or the key lacks permission (HTTP ${status}).`, 'rejected', status);
  }
  if (status === 429 || google === 'RESOURCE_EXHAUSTED') {
    // Google says WHICH quota ran out and when it can be used again (error.details: QuotaFailure.violations[].quotaId, RetryInfo.retryDelay). Use that
    // instead of guessing from the wording: a per-minute limit is back after the stated delay, a per-day limit at the daily reset.
    const info = quotaInfo(bodyText);
    if (info.quotaIds.some((q) => /perday/i.test(q)) || /per day|daily/.test(lower)) {
      const failure = new AiResponseError('rate_limited', status, model, `${message ?? 'quota exhausted'} (daily quota, resets at midnight Pacific time)`);
      failure.retryAfterMs = pacificMidnightDelayMs();
      return failure;
    }
    if (info.quotaIds.some((q) => /perminute/i.test(q))) {
      const failure = new AiResponseError('rate_limited', status, model, message);
      const waitMs = info.retryDelayMs ?? (retryAfter > 0 ? retryAfter * 1000 : 60_000);
      failure.retryAfterMs = Math.min(Math.max(waitMs, 1000), 25 * 3_600_000);
      return failure;
    }
    // Any other HTTP 429 / RESOURCE_EXHAUSTED is a QUOTA or rate limit: it is neither a rejected key nor a billing error, and it is never answered with a paid route.
    // Only a reset time Google actually states (RetryInfo, Retry-After) is kept; without one the router backs off by its own bounded schedule and says so.
    const failure = new AiResponseError('rate_limited', status, model, message);
    const stated = info.retryDelayMs ?? (retryAfter > 0 ? retryAfter * 1000 : 0);
    if (stated >= 1000) failure.retryAfterMs = Math.min(stated, 25 * 3_600_000);
    return failure;
  }
  if (status === 402) return new AiResponseError('payment_required', status, model, message);
  if (status === 404 || google === 'NOT_FOUND') return new AiResponseError('model_unavailable', status, model, message ?? 'model not found for this API version');
  if (status >= 500) return new AiResponseError('provider_error', status, model, message);
  return new AiResponseError('model_unavailable', status, model, message);
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  authentication: 'x-goog-api-key: <key>',
  async complete(request: AdapterCompleteRequest): Promise<ChatCompletionResponse> {
    const base = (request.baseUrl || BASE_DEFAULT).replace(/\/+$/, '');
    const model = request.model.replace(/^models\//, '');
    let response: Response;
    try {
      response = await fetchWithTimeout(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(request.apiKey ? { 'x-goog-api-key': request.apiKey } : {}) },
        body: JSON.stringify(toGeminiRequest(request)),
      }, Math.max(1000, request.timeoutMs));
    } catch (error) {
      const failure = new AiResponseError('provider_error', null, request.model, (error as Error)?.name === 'AbortError' ? 'timeout' : (error as Error)?.name ?? 'network error');
      failure.network = true;
      throw failure;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => undefined);
      throw failureFor(response.status, text, request.model, response.headers);
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch { throw new AiResponseError('malformed_response', response.status, request.model); }
    return fromGeminiResponse(parsed, request.model);
  },
};
