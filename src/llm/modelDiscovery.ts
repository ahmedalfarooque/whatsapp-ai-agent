import { env } from '../config/env';
import { checkProviderEndpoint, describeEndpointRefusal, isLoopbackUrl, normalizeProviderBaseUrl } from './endpointPolicy';
import { describeNetworkFailure } from './openAiCompatible';
import { ANTHROPIC_VERSION } from './adapters/anthropicAdapter';
import { vendorById, endpointMatchesVendor } from './adapters';
import { listOmniRouteModels } from './omniRoute';

/**
 * "Load models": asks a provider for the model ids its OWN API lists for this key. A list is a set of suggestions, never proof that a model works or is free:
 * the model the administrator picks is still tested with a real request when saved. Only the vendor's official host (or the administrator's HTTPS custom endpoint,
 * checked by the same endpoint policy as every provider) is contacted; redirects are refused; the key is sent only to that host and never returned or logged.
 */
export type PriceClass = 'free' | 'paid_or_unknown' | 'gateway_combo';
export interface DiscoveredModel { id: string; label?: string; price: PriceClass }
export type DiscoveryFailure = 'unsupported_vendor' | 'endpoint_refused' | 'missing_key' | 'rejected' | 'rate_limited' | 'unreachable' | 'unsupported' | 'unreadable' | 'gateway_not_running' | 'gateway_key_missing';
export type DiscoveryResult =
  | { ok: true; models: DiscoveredModel[]; truncated: boolean; note: string }
  | { ok: false; reason: DiscoveryFailure; message: string };

export const MAX_DISCOVERED = 400;
const MODEL_ID = /^(?!.*:\/\/)[A-Za-z0-9._:/@-]{1,120}$/;
const TIMEOUT_MS = 10_000;

const FAILURE_TEXT: Record<DiscoveryFailure, string> = {
  unsupported_vendor: 'This provider is not recognised.',
  endpoint_refused: 'This address is not allowed for a provider.',
  missing_key: 'Enter the API key first; the model list is read with it.',
  rejected: 'The provider refused this key, so no model list could be read. Check the key.',
  rate_limited: 'The provider is rate limiting requests right now. Try again later, or type a model id by hand (it is tested with a real request when you save).',
  unreachable: 'The provider could not be reached.',
  unsupported: 'This provider does not offer a model list through its API. Type a model id by hand; it is tested with a real request when you save.',
  unreadable: 'The provider answered, but the model list could not be understood. Type a model id by hand; it is tested with a real request when you save.',
  gateway_not_running: 'OmniRoute is not running at its address on this server, so there are no models to list. Start the gateway (see docs/OMNIROUTE.md).',
  gateway_key_missing: 'OmniRoute is running but no gateway key is configured on this server (OMNIROUTE_API_KEY).',
};
const failure = (reason: DiscoveryFailure, extra = ''): DiscoveryResult => ({ ok: false, reason, message: `${FAILURE_TEXT[reason]}${extra}` });

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

function cleanIds(ids: Array<{ id: unknown; label?: unknown; price?: PriceClass }>): DiscoveredModel[] {
  const seen = new Set<string>();
  const out: DiscoveredModel[] = [];
  for (const m of ids) {
    const id = typeof m.id === 'string' ? m.id : '';
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, ...(typeof m.label === 'string' && m.label ? { label: m.label.slice(0, 80) } : {}), price: m.price ?? 'paid_or_unknown' });
  }
  return out.sort((a, b) => Number(b.price === 'free') - Number(a.price === 'free') || a.id.localeCompare(b.id));
}

export async function discoverModels(
  input: { vendor: string; baseUrl?: string; apiKey?: string | null },
  deps: { fetch?: Fetcher; allowLocal?: boolean } = {},
): Promise<DiscoveryResult> {
  const vendor = vendorById(input.vendor);
  if (!vendor) return failure('unsupported_vendor');
  if (vendor.id === 'omniroute') {
    // The address and key the administrator is saving, under the same endpoint policy as every other provider; the gateway must also be on THIS machine.
    const gatewayUrl = normalizeProviderBaseUrl(input.baseUrl?.trim() || '');
    if (gatewayUrl) {
      const refused = checkProviderEndpoint(gatewayUrl, deps.allowLocal ?? env.allowLocalHttpProviders);
      if (refused) return failure('endpoint_refused', ` ${describeEndpointRefusal(refused)}`);
      if (!isLoopbackUrl(gatewayUrl)) return failure('endpoint_refused', ' The OmniRoute gateway must run on this server (127.0.0.1).');
    }
    const list = await listOmniRouteModels({ baseUrl: gatewayUrl || undefined, apiKey: input.apiKey });
    if (!list.ok) return list.reason === 'not_running' ? failure('gateway_not_running') : list.reason === 'no_key' ? failure('gateway_key_missing') : list.reason === 'rejected' ? failure('rejected') : failure('unreadable');
    const models = cleanIds(list.models.map((id) => ({ id, price: id.startsWith('auto/') ? 'gateway_combo' as const : 'paid_or_unknown' as const })));
    return { ok: true, models, truncated: list.truncated, note: 'Read from the gateway. A combo (auto/…) is only as free as the accounts connected inside OmniRoute; any other model may be billed. Pick one and it is tested with a real request.' };
  }
  const baseUrl = normalizeProviderBaseUrl(input.baseUrl?.trim() || vendor.baseUrl); // the same spelling that is saved and used for inference
  const refusal = baseUrl ? checkProviderEndpoint(baseUrl, deps.allowLocal ?? env.allowLocalHttpProviders) : 'invalid_url';
  if (refusal) return failure('endpoint_refused', ` ${describeEndpointRefusal(refusal)}`);
  if (vendor.hosts.length > 0 && !endpointMatchesVendor(vendor.id, baseUrl)) return failure('endpoint_refused', ' A known provider must use its official API address.');
  const key = (input.apiKey ?? '').trim();
  if (!key) return failure('missing_key');

  const doFetch: Fetcher = deps.fetch ?? ((url, init) => fetch(url, init));
  let url = `${baseUrl}/models`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (vendor.adapter === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = ANTHROPIC_VERSION; url += '?limit=200'; }
  else if (vendor.adapter === 'gemini') { headers['x-goog-api-key'] = key; url += '?pageSize=200'; }
  else headers.Authorization = `Bearer ${key}`;

  let response: Response;
  try {
    response = await doFetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    return failure('unreachable', ` (${describeNetworkFailure(error)})`);
  }
  if (response.status === 401 || response.status === 403) return failure('rejected');
  if (response.status === 429) return failure('rate_limited');
  if (response.status === 404 || response.status === 405) return failure('unsupported');
  if (!response.ok) return failure('unreachable', ` (HTTP ${response.status})`);
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;

  let rows: Array<{ id: unknown; label?: unknown; price?: PriceClass }> | null = null;
  if (vendor.adapter === 'gemini') {
    const list = body && Array.isArray(body.models) ? (body.models as Array<Record<string, unknown>>) : null;
    // only models that can generate text/answers; embedding and image-only ones are not chat routes
    rows = list ? list.filter((m) => !Array.isArray(m.supportedGenerationMethods) || (m.supportedGenerationMethods as unknown[]).includes('generateContent'))
      .map((m) => ({ id: typeof m.name === 'string' ? m.name.replace(/^models\//, '') : '', label: m.displayName })) : null;
  } else if (body && Array.isArray(body.data)) {
    rows = (body.data as Array<Record<string, unknown>>).map((m) => {
      const pricing = m.pricing as { prompt?: unknown; completion?: unknown } | undefined;
      const free = vendor.kind === 'openrouter' && pricing && Number(pricing.prompt) === 0 && Number(pricing.completion) === 0;
      return { id: m.id, label: m.display_name ?? m.name, price: free ? 'free' as const : 'paid_or_unknown' as const };
    });
  }
  if (!rows) return failure('unreadable');
  const models = cleanIds(rows);
  if (!models.length) return failure('unreadable');
  const note = vendor.kind === 'openrouter'
    ? 'Models marked free have a price of 0 in OpenRouter\'s own catalog (free models also need your account privacy setting to allow them). Pick one and it is tested with a real request.'
    : 'The list says which models your key can reach, not which are free. Pick one and it is tested with a real request; free eligibility stays your confirmation.';
  return { ok: true, models: models.slice(0, MAX_DISCOVERED), truncated: models.length > MAX_DISCOVERED, note };
}
