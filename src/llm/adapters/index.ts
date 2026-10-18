import { geminiAdapter } from './geminiAdapter';
import { openAiAdapter, openRouterAdapter } from './openaiAdapter';
import { type AdapterId, type DiscoveredModel, type ProviderAdapter } from './types';

export * from './types';
export { VENDORS, vendorById, vendorForUrl, endpointMatchesVendor, type Vendor } from './vendors';

const REGISTRY: Record<AdapterId, ProviderAdapter> = { openrouter: openRouterAdapter, openai: openAiAdapter, gemini: geminiAdapter };

/** The adapter that speaks a provider's protocol (an unknown id falls back to the OpenAI protocol, the only one a custom endpoint can use). */
export function adapterFor(id: string | null | undefined): ProviderAdapter {
  return REGISTRY[(id as AdapterId) in REGISTRY ? (id as AdapterId) : 'openai'];
}

export const isAdapterId = (id: unknown): id is AdapterId => typeof id === 'string' && id in REGISTRY;

/** The provider's own model list through its adapter. Never returns a model it did not report; sorted for display. */
export async function discoverModels(adapterId: string, context: { baseUrl: string; apiKey: string | null; timeoutMs?: number }): Promise<DiscoveredModel[]> {
  const list = await adapterFor(adapterId).listModels({ baseUrl: context.baseUrl, apiKey: context.apiKey, timeoutMs: context.timeoutMs ?? 15_000 });
  return list.sort((a, b) => a.id.localeCompare(b.id));
}
