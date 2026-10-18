import { fetchWithTimeout } from '../../utils/retry';
import { AiCredentialError } from '../aiCredentialError';
import { AiResponseError } from '../aiResponseError';
import { providerMessageOf } from '../openAiCompatible';
import type { ChatCompletionResponse, ChatMessage, ContentPart, ToolCall } from '../types';
import { ModelDiscoveryError, type AdapterCompleteRequest, type DiscoveredModel, type DiscoveryContext, type ProviderAdapter } from './types';

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
    generationConfig: { temperature: request.temperature ?? 0.4, maxOutputTokens: request.maxTokens ?? 600 },
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
  if (!text && toolCalls.length === 0) throw new AiResponseError('empty_response', 200, model);
  return { choices: [{ index: 0, finish_reason: toolCalls.length ? 'tool_calls' : candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop', message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }] };
}

/** Gemini's documented error statuses → the normalised error the router understands. */
function failureFor(status: number, bodyText: string | undefined, model: string, retryAfter: number): AiResponseError | AiCredentialError {
  let google = '';
  try { google = String((JSON.parse(bodyText ?? '{}') as { error?: { status?: unknown } }).error?.status ?? ''); } catch { /* not JSON */ }
  const message = providerMessageOf(bodyText);
  const lower = (message ?? '').toLowerCase();
  // A bad key is reported as HTTP 400 INVALID_ARGUMENT ("API key not valid") or 401/403.
  if (status === 401 || status === 403 || google === 'PERMISSION_DENIED' || google === 'UNAUTHENTICATED' || /api key not valid|api_key_invalid|api key expired/.test(lower)) {
    return new AiCredentialError(`The provider refused the API key or the key lacks permission (HTTP ${status}).`, 'rejected', status);
  }
  if (status === 429 || google === 'RESOURCE_EXHAUSTED') {
    // Quota exhausted (daily / free-tier allowance) rests longer than a momentary rate limit.
    const quota = /quota|billing|exceeded your current|free tier|per day|daily/.test(lower);
    const failure = new AiResponseError(quota ? 'payment_required' : 'rate_limited', status, model, message);
    if (retryAfter > 0) failure.retryAfterMs = Math.min(retryAfter * 1000, 15 * 60_000);
    return failure;
  }
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
      throw failureFor(response.status, text, request.model, Number(response.headers?.get?.('retry-after') ?? ''));
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch { throw new AiResponseError('malformed_response', response.status, request.model); }
    return fromGeminiResponse(parsed, request.model);
  },
  async listModels(context: DiscoveryContext): Promise<DiscoveredModel[]> {
    const base = (context.baseUrl || BASE_DEFAULT).replace(/\/+$/, '');
    let response: Response;
    try {
      response = await fetchWithTimeout(`${base}/models?pageSize=200`, { method: 'GET', headers: context.apiKey ? { 'x-goog-api-key': context.apiKey } : {} }, Math.max(1000, context.timeoutMs));
    } catch (error) {
      throw new ModelDiscoveryError('network', null, (error as Error)?.name === 'AbortError' ? 'The provider did not answer in time.' : 'The provider could not be reached.');
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new ModelDiscoveryError('credential', response.status, 'Google refused the API key or the key lacks permission to list models.');
    if (response.status === 404) throw new ModelDiscoveryError('endpoint_not_found', 404, 'This address has no Gemini model list. Use https://generativelanguage.googleapis.com/v1beta.');
    if (response.status === 429) throw new ModelDiscoveryError('rate_limited', 429, 'Google is rate limiting requests right now.');
    if (!response.ok) throw new ModelDiscoveryError('provider_error', response.status, `Google answered HTTP ${response.status}.`);
    let body: { models?: unknown };
    try { body = (await response.json()) as { models?: unknown }; } catch { throw new ModelDiscoveryError('malformed', response.status, 'Google answered something that is not a model list.'); }
    if (!Array.isArray(body.models)) throw new ModelDiscoveryError('malformed', response.status, 'Google answered something that is not a model list.');
    const out: DiscoveredModel[] = [];
    for (const raw of body.models as Array<Record<string, unknown>>) {
      const name = typeof raw?.name === 'string' ? raw.name.replace(/^models\//, '') : null;
      const methods = Array.isArray(raw?.supportedGenerationMethods) ? (raw.supportedGenerationMethods as unknown[]).map(String) : [];
      if (!name || !methods.includes('generateContent')) continue; // embedding / other models cannot answer a chat
      const limit = Number(raw.inputTokenLimit);
      out.push({ id: name, label: typeof raw.displayName === 'string' ? raw.displayName : undefined, contextLength: Number.isFinite(limit) && limit > 0 ? limit : undefined, modalities: 'generateContent', free: null, evidence: 'Google\'s model list does not say which models are in the free tier: check the rate-limit page for your key, then confirm the free tier yourself.' });
    }
    return out;
  },
};
