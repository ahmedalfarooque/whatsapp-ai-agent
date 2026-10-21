import { completeOnce, openRouterHeaders } from '../openAiCompatible';
import type { AdapterId, ProviderAdapter } from './types';

const isGroq = (baseUrl: string): boolean => { try { return /(^|\.)groq\.com$/i.test(new URL(baseUrl).hostname); } catch { return false; } };

/**
 * The OpenAI chat-completions protocol (POST {base}/chat/completions, `Authorization: Bearer`). It is the real, documented contract of OpenRouter,
 * Groq, Mistral, xAI, Cerebras and many custom endpoints; it is one adapter among several, not the rule. OpenRouter differs only by its
 * attribution headers. No model list is read: a model is trusted only after a real inference answered (src/llm/autoSetup.ts).
 */
function createOpenAiProtocolAdapter(id: AdapterId, openRouter: boolean): ProviderAdapter {
  return {
    id,
    authentication: 'Authorization: Bearer <key>',
    complete: (request) => completeOnce({ ...request, headers: openRouter ? openRouterHeaders() : undefined, tokenParam: isGroq(request.baseUrl) ? 'max_completion_tokens' : undefined }),
  };
}

export const openRouterAdapter = createOpenAiProtocolAdapter('openrouter', true);
export const openAiAdapter = createOpenAiProtocolAdapter('openai', false);
