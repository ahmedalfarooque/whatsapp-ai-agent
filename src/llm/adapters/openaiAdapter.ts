import { completeOnce, openRouterHeaders } from '../openAiCompatible';
import type { AdapterId, ProviderAdapter } from './types';

const hostOf = (baseUrl: string): string => { try { return new URL(baseUrl).hostname.toLowerCase(); } catch { return ''; } };
const isGroq = (baseUrl: string): boolean => /(^|\.)groq\.com$/.test(hostOf(baseUrl));
/** OpenAI itself documents `max_completion_tokens` and accepts only the default temperature on its current models. */
const isOpenAi = (baseUrl: string): boolean => hostOf(baseUrl) === 'api.openai.com';

/**
 * The OpenAI chat-completions protocol (POST {base}/chat/completions, `Authorization: Bearer`). It is the real, documented contract of OpenRouter,
 * Groq, Mistral, xAI, Cerebras and many custom endpoints; it is one adapter among several, not the rule. OpenRouter differs only by its
 * attribution headers. No model list is read: a model is trusted only after a real inference answered (src/llm/autoSetup.ts).
 */
function createOpenAiProtocolAdapter(id: AdapterId, openRouter: boolean): ProviderAdapter {
  return {
    id,
    authentication: 'Authorization: Bearer <key>',
    complete: (request) => completeOnce({ ...request, headers: openRouter ? openRouterHeaders() : undefined, tokenParam: isGroq(request.baseUrl) || isOpenAi(request.baseUrl) ? 'max_completion_tokens' : undefined, omitTemperature: isOpenAi(request.baseUrl) }),
  };
}

export const openRouterAdapter = createOpenAiProtocolAdapter('openrouter', true);
export const openAiAdapter = createOpenAiProtocolAdapter('openai', false);
