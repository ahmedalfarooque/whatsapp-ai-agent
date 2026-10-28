import { fetchWithTimeout } from '../../utils/retry';
import { AiCredentialError } from '../aiCredentialError';
import { AiResponseError } from '../aiResponseError';
import { providerMessageOf, statedRetryDelayMs } from '../openAiCompatible';
import type { ChatCompletionResponse, ChatMessage, ContentPart, ToolCall } from '../types';
import type { AdapterCompleteRequest, ProviderAdapter } from './types';

/**
 * Anthropic Claude, its own native contract (https://docs.anthropic.com/en/api/messages), not the OpenAI shape:
 *   POST {base}/messages     headers `x-api-key: <key>`, `anthropic-version: 2023-06-01`, `content-type: application/json`
 *   body  { model, max_tokens (REQUIRED), system, temperature (0..1), messages:[{role:"user"|"assistant", content: string | blocks}],
 *           tools:[{name, description, input_schema}] }
 *         blocks: {type:"text",text} | {type:"image",source:{type:"base64",media_type,data}} | {type:"tool_use",id,name,input} | {type:"tool_result",tool_use_id,content}
 *   answer { content:[{type:"text",text}|{type:"tool_use",id,name,input}], stop_reason:"end_turn"|"max_tokens"|"tool_use"|"stop_sequence"|"refusal" }
 *   GET  {base}/models       → { data:[{ id, display_name, type:"model" }], has_more }
 *   errors { type:"error", error:{ type, message } } — authentication_error (401) / permission_error (403) / not_found_error (404) / request_too_large (413) /
 *          rate_limit_error (429, with Retry-After) / api_error (500) / overloaded_error (529); a spent credit balance arrives as HTTP 400 invalid_request_error.
 * The agent loop speaks the OpenAI message shape, so this adapter translates both ways; the router never sees an Anthropic structure.
 * UNVERIFIED against a live key in this repository's tests (no Anthropic key was available): the host, paths and error shape were confirmed with unauthenticated
 * requests only (HTTP 401 authentication_error). The model is therefore never guessed: the administrator picks one from the account's own model list and it is tested
 * with a real request before the provider counts as working.
 */
export const ANTHROPIC_VERSION = '2023-06-01';
const BASE_DEFAULT = 'https://api.anthropic.com/v1';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

type Block = Record<string, unknown>;
type Turn = { role: 'user' | 'assistant'; content: Block[] };

/** Tool-call ids must match ^[a-zA-Z0-9_-]{1,64}$ on Anthropic's side. */
const safeId = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'call';

function blocksOf(content: ChatMessage['content']): Block[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Block[] = [];
  for (const p of content as ContentPart[]) {
    if (p.type === 'text') { if (p.text) out.push({ type: 'text', text: p.text }); continue; }
    if (p.type === 'image_url') {
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(p.image_url.url);
      if (m && IMAGE_TYPES.has(m[1]!.toLowerCase())) out.push({ type: 'image', source: { type: 'base64', media_type: m[1]!.toLowerCase(), data: m[2] } });
      continue; // a remote image URL is never fetched on the model's behalf
    }
    // audio input is not an Anthropic input type: the router never sends audio to a provider that does not list an audio model
  }
  return out;
}

/** OpenAI-shaped history → Anthropic `system` + alternating `messages`. All tool results of one assistant turn are returned together in ONE user turn, as the API requires. */
export function toAnthropicRequest(request: AdapterCompleteRequest): Record<string, unknown> {
  const system: string[] = [];
  const turns: Turn[] = [];
  const push = (role: Turn['role'], blocks: Block[]): void => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role && !(role === 'user' && last.content.some((b) => b.type === 'tool_result') !== blocks.some((b) => b.type === 'tool_result'))) last.content.push(...blocks);
    else turns.push({ role, content: [...blocks] });
  };
  for (const m of request.messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : blocksOf(m.content).map((b) => String(b.text ?? '')).join('');
      if (text) system.push(text);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = blocksOf(m.content);
      for (const call of m.tool_calls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(call.function.arguments || '{}'); } catch { input = {}; }
        blocks.push({ type: 'tool_use', id: safeId(call.id), name: call.function.name, input: input && typeof input === 'object' ? input : {} });
      }
      push('assistant', blocks);
      continue;
    }
    if (m.role === 'tool') {
      const last = turns[turns.length - 1];
      const block: Block = { type: 'tool_result', tool_use_id: safeId(m.tool_call_id ?? 'call'), content: typeof m.content === 'string' ? m.content : '' };
      if (last && last.role === 'user' && last.content.every((b) => b.type === 'tool_result')) last.content.push(block); else turns.push({ role: 'user', content: [block] });
      continue;
    }
    push('user', blocksOf(m.content));
  }
  // The conversation starts and ends with the customer's side (a trailing assistant turn is a "prefill" that current models refuse).
  if (turns.length === 0 || turns[0]!.role === 'assistant') turns.unshift({ role: 'user', content: [{ type: 'text', text: '(conversation start)' }] });
  const tail = turns[turns.length - 1]!;
  if (tail.role === 'assistant' && !tail.content.some((b) => b.type === 'tool_use')) turns.push({ role: 'user', content: [{ type: 'text', text: 'Please reply to my latest message above.' }] });
  return {
    model: request.model,
    max_tokens: Math.max(1, Math.min(request.maxTokens ?? 600, 8192)),
    ...(system.length ? { system: system.join('\n\n') } : {}),
    temperature: Math.min(Math.max(request.temperature ?? 0.4, 0), 1), // Anthropic accepts 0..1
    messages: turns,
    ...(request.tools && request.tools.length ? { tools: request.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters ?? { type: 'object', properties: {} } })) } : {}),
  };
}

/** Anthropic answer → the OpenAI-shaped completion the rest of the application reads. An answer with neither text nor a tool call is a failure, never a reply. */
export function fromAnthropicResponse(parsed: unknown, model: string): ChatCompletionResponse {
  const body = parsed as { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>; stop_reason?: string } | null;
  if (!body || !Array.isArray(body.content)) throw new AiResponseError('malformed_response', 200, model);
  const text = body.content.map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('').trim();
  const toolCalls: ToolCall[] = [];
  body.content.forEach((b, i) => {
    if (b.type === 'tool_use' && typeof b.name === 'string') toolCalls.push({ id: safeId(b.id ?? `call_${i}_${b.name}`), type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
  });
  if (!text && toolCalls.length === 0) {
    if (body.stop_reason === 'refusal') throw new AiResponseError('model_unavailable', 200, model, 'the model declined this request');
    throw new AiResponseError('empty_response', 200, model, `empty answer; stop_reason=${String(body.stop_reason ?? 'none').slice(0, 30)}`);
  }
  return { choices: [{ index: 0, finish_reason: toolCalls.length ? 'tool_calls' : body.stop_reason === 'max_tokens' ? 'length' : 'stop', message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }] };
}

/** Anthropic's documented error types and statuses → the normalised errors the router understands. */
export function anthropicFailure(status: number, bodyText: string | undefined, model: string, headers?: Headers): AiResponseError | AiCredentialError {
  let type = '';
  try { type = String((JSON.parse(bodyText ?? '{}') as { error?: { type?: unknown } }).error?.type ?? ''); } catch { /* not JSON */ }
  const message = providerMessageOf(bodyText);
  const lower = (message ?? '').toLowerCase();
  if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') return new AiCredentialError(`The provider refused the API key or the key lacks permission (HTTP ${status}).`, 'rejected', status);
  if (status === 402 || /credit balance|billing|payment/.test(lower)) return new AiResponseError('payment_required', status, model, message);
  if (status === 429 || type === 'rate_limit_error') {
    const failure = new AiResponseError('rate_limited', status, model, message);
    const stated = statedRetryDelayMs(headers, bodyText); // Retry-After, when Anthropic sends it
    if (stated) failure.retryAfterMs = stated;
    return failure;
  }
  if (status === 404 || type === 'not_found_error') return new AiResponseError('model_unavailable', status, model, message ?? 'model not found for this key');
  if (status >= 500 || type === 'api_error' || type === 'overloaded_error') return new AiResponseError('provider_error', status, model, message);
  return new AiResponseError('model_unavailable', status, model, message); // 400 invalid_request_error / 413 request_too_large: this request or model, not an outage
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  authentication: 'x-api-key: <key>',
  async complete(request: AdapterCompleteRequest): Promise<ChatCompletionResponse> {
    const base = (request.baseUrl || BASE_DEFAULT).replace(/\/+$/, '');
    let response: Response;
    try {
      response = await fetchWithTimeout(`${base}/messages`, {
        method: 'POST',
        redirect: 'error', // a provider address never bounces the API key to another host
        headers: { 'Content-Type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, ...(request.apiKey ? { 'x-api-key': request.apiKey } : {}) },
        body: JSON.stringify(toAnthropicRequest(request)),
      }, Math.max(1000, request.timeoutMs));
    } catch (error) {
      const failure = new AiResponseError('provider_error', null, request.model, (error as Error)?.name === 'AbortError' ? 'timeout' : (error as Error)?.name ?? 'network error');
      failure.network = true;
      throw failure;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => undefined);
      throw anthropicFailure(response.status, text, request.model, response.headers);
    }
    let parsed: unknown;
    try { parsed = await response.json(); } catch { throw new AiResponseError('malformed_response', response.status, request.model); }
    return fromAnthropicResponse(parsed, request.model);
  },
};
