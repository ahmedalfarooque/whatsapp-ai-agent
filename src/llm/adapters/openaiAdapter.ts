import { fetchWithTimeout } from '../../utils/retry';
import { completeOnce, openRouterHeaders } from '../openAiCompatible';
import { ModelDiscoveryError, type AdapterId, type DiscoveredModel, type DiscoveryContext, type ProviderAdapter } from './types';

/**
 * The OpenAI chat-completions protocol (POST {base}/chat/completions, `Authorization: Bearer`, GET {base}/models). It is the real, documented
 * contract of OpenRouter, Groq, Mistral, xAI, Cerebras and many custom endpoints; it is one adapter among several, not the rule. OpenRouter
 * differs only by its attribution headers and by a model list that carries per-token prices (the one place price evidence exists).
 */
function createOpenAiProtocolAdapter(id: AdapterId, openRouter: boolean): ProviderAdapter {
  return {
    id,
    authentication: 'Authorization: Bearer <key>',
    complete: (request) => completeOnce({ ...request, headers: openRouter ? openRouterHeaders() : undefined }),
    async listModels(context: DiscoveryContext): Promise<DiscoveredModel[]> {
      let response: Response;
      try {
        response = await fetchWithTimeout(`${context.baseUrl.replace(/\/+$/, '')}/models`, { method: 'GET', headers: { ...(context.apiKey ? { Authorization: `Bearer ${context.apiKey}` } : {}), ...(openRouter ? openRouterHeaders() : {}) } }, Math.max(1000, context.timeoutMs));
      } catch (error) {
        throw new ModelDiscoveryError('network', null, (error as Error)?.name === 'AbortError' ? 'The provider did not answer in time.' : 'The provider could not be reached.');
      }
      if (response.status === 401 || response.status === 403) throw new ModelDiscoveryError('credential', response.status, 'The provider refused the API key or the key lacks permission to list models.');
      if (response.status === 404) throw new ModelDiscoveryError('endpoint_not_found', 404, 'This address has no model-list endpoint. The endpoint must be the provider\'s API base URL (for example https://api.example.com/v1), not a web page.');
      if (response.status === 429 || response.status === 408) throw new ModelDiscoveryError('rate_limited', response.status, 'The provider is rate limiting requests right now.');
      if (!response.ok) throw new ModelDiscoveryError('provider_error', response.status, `The provider answered HTTP ${response.status}.`);
      let body: { data?: unknown };
      try { body = (await response.json()) as { data?: unknown }; } catch { throw new ModelDiscoveryError('malformed', response.status, 'The provider answered something that is not a model list.'); }
      if (!Array.isArray(body.data)) throw new ModelDiscoveryError('malformed', response.status, 'The provider answered something that is not a model list.');
      const out: DiscoveredModel[] = [];
      for (const raw of body.data as Array<Record<string, unknown>>) {
        if (typeof raw?.id !== 'string') continue;
        const input = Array.isArray(raw.input_modalities) ? (raw.input_modalities as unknown[]).map(String).join(',') : null;
        const output = Array.isArray(raw.output_modalities) ? (raw.output_modalities as unknown[]).map(String).join(',') : null;
        const context_ = Number(raw.context_length ?? raw.context_window);
        let free: boolean | null = null;
        let evidence = 'This provider\'s model list does not publish prices: confirm the free tier yourself.';
        if (openRouter) {
          const pricing = raw.pricing as { prompt?: unknown; completion?: unknown } | undefined;
          const prompt = pricing ? Number(pricing.prompt) : NaN;
          const completion = pricing ? Number(pricing.completion) : NaN;
          if (Number.isFinite(prompt) && Number.isFinite(completion)) {
            free = prompt === 0 && completion === 0;
            evidence = free ? 'OpenRouter\'s catalog lists a price of 0 for prompt and completion.' : 'OpenRouter\'s catalog lists a price for this model: it is not free.';
          } else evidence = 'OpenRouter\'s catalog gave no price for this model: treated as unverified.';
        }
        out.push({ id: raw.id, label: typeof raw.name === 'string' ? raw.name : undefined, contextLength: Number.isFinite(context_) && context_ > 0 ? context_ : undefined, modalities: input || output ? `${input ?? '?'} → ${output ?? '?'}` : undefined, free, evidence });
      }
      return out;
    },
  };
}

export const openRouterAdapter = createOpenAiProtocolAdapter('openrouter', true);
export const openAiAdapter = createOpenAiProtocolAdapter('openai', false);
