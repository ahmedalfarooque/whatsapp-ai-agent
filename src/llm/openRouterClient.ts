import { env } from '../config/env';
import { describeCredential, getEffectiveCredential, isUsableApiKey } from '../config/effectiveConfig';
import { getBusinessSettings } from '../config/businessSettings';
import { logger } from '../logger';
import { chatCompletionMock } from './mockOpenRouterClient';
import { AiCredentialError } from './aiCredentialError';
import { AiResponseError } from './aiResponseError';
import { routeCompletion, type AiTask, type RouteCandidate } from './aiRouter';
import { getModelInfo } from './modelCatalog';
import type { ChatCompletionResponse, ChatMessage } from './types';
import type { ToolDefinition } from '../tools';

export { validateCompletion } from './openAiCompatible';

/**
 * The chat-completion entry point used by the agent loop, the vision and audio steps and the tests. Every call goes through the AI
 * routing layer (src/llm/aiRouter.ts): the business's configured providers, the built-in OpenRouter key and the built-in local route,
 * in priority order, free-only when the business says so, one route after another within a bounded budget. The name is historical: the
 * built-in OpenRouter key is one route among the others.
 */
export interface ChatCompletionRequest {
  messages: ChatMessage[];
  /** A shorter rendering of the same conversation, used for a slow local model. */
  tools?: ToolDefinition['schema'][];
  temperature?: number;
  maxTokens?: number;
  /** Epoch ms after which no new attempt may start (the whole AI loop's time budget). */
  deadline?: number;
  /** Legacy: pins ONE OpenRouter model with the built-in key and no routing (the dashboard's probes). Prefer `task`. */
  model?: string;
  /** Legacy per-attempt timeout for a pinned model. */
  timeoutMs?: number;
  /** Legacy retry count for a pinned model (0 or 1). */
  retries?: number;
  /** The AI task: decides which models and capabilities the router considers. Default 'chat'. */
  task?: AiTask;
  /** What a route must be able to take for THIS request (a text-only model is never given a picture or a recording). */
  requires?: { image?: boolean; audio?: boolean };
  /** Legacy flag kept for callers; the router always fails over when the business allows it. */
  allowFallback?: boolean;
}

const REJECTED_LOG_INTERVAL_MS = 5 * 60_000;
let lastRejectedLogAt = 0;

/** The built-in OpenRouter key, or a clear AiCredentialError. An empty, malformed or undecryptable value is never sent to the provider. */
export function usableApiKey(): string {
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

/** Legacy pinned-model path: ONE OpenRouter model with the built-in key, no routing (used by the dashboard probes and old callers). */
async function pinnedCandidate(model: string, timeoutMs: number): Promise<RouteCandidate> {
  const apiKey = usableApiKey();
  const info = await getModelInfo(model);
  return {
    key: `builtin:${model}`, providerKey: 'provider:builtin', providerId: null, providerName: 'OpenRouter (built-in key)', kind: 'openrouter', adapter: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey, model,
    free: info ? info.free : null, image: info ? info.image : true, audio: info ? info.audio : true, tools: info ? info.tools : null, timeoutMs, builtin: true,
  };
}

/** Calls the AI routing layer (or, for a pinned legacy model, the built-in OpenRouter key alone). */
export async function chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  if (env.shouldUseMockProviders) {
    return chatCompletionMock(request.messages);
  }
  if (request.model && !request.task) {
    // Pinned model: the only route is this one; the router gives it one bounded retry on a transient failure (its "only route" rule).
    const candidate = await pinnedCandidate(request.model, request.timeoutMs ?? env.OPENROUTER_TIMEOUT_MS);
    try {
      return await routeCompletion({ task: 'chat', messages: request.messages, tools: request.tools, temperature: request.temperature, maxTokens: request.maxTokens, deadline: request.deadline, candidatesOverride: [candidate] });
    } catch (error) {
      if (error instanceof AiCredentialError && error.reason === 'rejected' && error.httpStatus) noteRejected(error.httpStatus);
      throw error;
    }
  }
  const task: AiTask = request.task ?? 'chat';
  try {
    return await routeCompletion({ task, messages: request.messages, tools: request.tools, temperature: request.temperature, maxTokens: request.maxTokens, deadline: request.deadline, needs: request.requires });
  } catch (error) {
    if (error instanceof AiCredentialError && error.reason === 'rejected' && error.httpStatus) noteRejected(error.httpStatus);
    throw error;
  }
}

/** The business's chat model name (for logs and the dashboard; the router may answer with another route). */
export function configuredChatModel(): string {
  return getBusinessSettings().openRouterModel;
}

export { AiResponseError };
