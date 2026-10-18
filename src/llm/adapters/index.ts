import { geminiAdapter } from './geminiAdapter';
import { openAiAdapter, openRouterAdapter } from './openaiAdapter';
import { type AdapterId, type ProviderAdapter } from './types';

export * from './types';
export { VENDORS, vendorById, vendorForUrl, endpointMatchesVendor, type Vendor } from './vendors';

const REGISTRY: Record<AdapterId, ProviderAdapter> = { openrouter: openRouterAdapter, openai: openAiAdapter, gemini: geminiAdapter };

/** The adapter that speaks a provider's protocol (an unknown id falls back to the OpenAI protocol, the only one a custom endpoint can use). */
export function adapterFor(id: string | null | undefined): ProviderAdapter {
  return REGISTRY[(id as AdapterId) in REGISTRY ? (id as AdapterId) : 'openai'];
}

export const isAdapterId = (id: unknown): id is AdapterId => typeof id === 'string' && id in REGISTRY;
