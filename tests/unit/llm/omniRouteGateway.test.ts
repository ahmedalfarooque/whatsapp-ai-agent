import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../src/config/env';
import { GATEWAY_SUMMARY_PREFIX } from '../../../src/llm/openAiCompatible';
import { checkOmniRouteGateway, gatewayStateOfAttempt, listOmniRouteModels, setOmniRouteKeyFileEnabledForTests } from '../../../src/llm/omniRoute';
import { discoverModels } from '../../../src/llm/modelDiscovery';

// MOCKED gateway: these tests prove the app's logic against scripted answers. They are not evidence that any real upstream works.
const mutableEnv = env as unknown as Record<string, unknown>;
const KEY = 'sk-0123456789abcdef0123456789abcdef';
const BASE = 'http://127.0.0.1:20128/v1';
type Call = { url: string; auth: string | null };
let calls: Call[];

function gateway(opts: { healthy?: boolean; models?: string[]; acceptKey?: string } = {}): void {
  const { healthy = true, models = ['auto/best-free', 'alpha/works'], acceptKey = KEY } = opts;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    calls.push({ url, auth });
    if (url.endsWith('/api/monitoring/health')) return healthy ? new Response(JSON.stringify({ status: 'healthy' }), { status: 200 }) : new Response('down', { status: 503 });
    if (url.endsWith('/models')) return auth === `Bearer ${acceptKey}` ? new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 }) : new Response('{"error":"Invalid API key"}', { status: 401 });
    return new Response('{}', { status: 404 });
  }));
}

beforeEach(() => { calls = []; mutableEnv.OMNIROUTE_API_KEY = ''; setOmniRouteKeyFileEnabledForTests(false); });
afterEach(() => { vi.unstubAllGlobals(); setOmniRouteKeyFileEnabledForTests(true); mutableEnv.OMNIROUTE_API_KEY = ''; });

describe('Load models uses the address and key the administrator is saving (not only the server environment)', () => {
  it('lists with the TYPED key and address even when the server has no OMNIROUTE_API_KEY', async () => {
    gateway();
    const out = await listOmniRouteModels({ baseUrl: BASE + '/', apiKey: ` ${KEY} ` });
    expect(out).toMatchObject({ ok: true, baseUrl: BASE });
    expect(calls.find((c) => c.url.endsWith('/models'))).toEqual({ url: `${BASE}/models`, auth: `Bearer ${KEY}` });
  });

  it('a typed key that is not shaped like a gateway key is refused and never sent', async () => {
    gateway();
    expect(await listOmniRouteModels({ baseUrl: BASE, apiKey: 'gsk_not_a_gateway_key' })).toMatchObject({ ok: false, reason: 'rejected' });
    expect(calls.some((c) => c.auth !== null)).toBe(false);
  });

  it('with nothing typed and nothing configured it says there is no key (and sends none)', async () => {
    gateway();
    expect(await listOmniRouteModels({ baseUrl: BASE })).toMatchObject({ ok: false, reason: 'no_key' });
    expect(calls.some((c) => c.auth !== null)).toBe(false);
  });

  it('through discoverModels: the typed key works, and an external or non-loopback gateway address is refused before any request', async () => {
    gateway();
    const ok = await discoverModels({ vendor: 'omniroute', baseUrl: BASE, apiKey: KEY }, { allowLocal: true });
    expect(ok).toMatchObject({ ok: true });
    calls = [];
    for (const baseUrl of ['http://example.com:20128/v1', 'http://130.110.112.192:20128/v1', 'https://gateway.example.com/v1']) {
      const refused = await discoverModels({ vendor: 'omniroute', baseUrl, apiKey: KEY }, { allowLocal: true });
      expect(refused, baseUrl).toMatchObject({ ok: false, reason: 'endpoint_refused' });
    }
    expect(calls).toHaveLength(0); // the key went nowhere
    const off = await discoverModels({ vendor: 'omniroute', baseUrl: BASE, apiKey: KEY }, { allowLocal: false });
    expect(off).toMatchObject({ ok: false, reason: 'endpoint_refused' });
    expect((off as { message: string }).message).toMatch(/local providers are switched off/);
  });
});

describe('the layered gateway check keeps its layers apart', () => {
  it('unreachable gateway', async () => {
    gateway({ healthy: false });
    const out = await checkOmniRouteGateway({ baseUrl: BASE, apiKey: KEY });
    expect(out).toMatchObject({ state: 'unreachable', layers: { reachable: false, keyAccepted: null, inference: 'not_run' } });
  });

  it('invalid gateway key is its own state and is not an upstream problem', async () => {
    gateway();
    const out = await checkOmniRouteGateway({ baseUrl: BASE, apiKey: 'sk-wrongwrongwrongwrongwrong0000' });
    expect(out).toMatchObject({ state: 'invalid_key', layers: { reachable: true, keyAccepted: false, inference: 'not_run' } });
    expect(out.message).toMatch(/gateway key, not an upstream provider key/);
  });

  it('no key anywhere', async () => {
    gateway();
    expect(await checkOmniRouteGateway({ baseUrl: BASE })).toMatchObject({ state: 'no_key', layers: { reachable: true, keyAccepted: null } });
  });

  it('a gateway with no models', async () => {
    gateway({ models: [] });
    expect(await checkOmniRouteGateway({ baseUrl: BASE, apiKey: KEY })).toMatchObject({ state: 'no_models', layers: { modelCount: 0 } });
  });

  it('models listed is NOT success: without a test request nothing claims the AI works and no inference is attempted', async () => {
    gateway();
    const infer = vi.fn();
    const out = await checkOmniRouteGateway({ baseUrl: BASE, apiKey: KEY });
    expect(out).toMatchObject({ state: 'models_listed', layers: { reachable: true, keyAccepted: true, modelCount: 2, inference: 'not_run' } });
    expect(out.message).toMatch(/not proof/);
    expect(infer).not.toHaveBeenCalled();
  });

  it('real inference success is the only state that says it works', async () => {
    gateway();
    const out = await checkOmniRouteGateway({ baseUrl: BASE, apiKey: KEY, infer: async () => ({ ok: true }) });
    expect(out).toMatchObject({ state: 'inference_ok', layers: { inference: 'ok' } });
  });

  it.each([
    ['no upstream (gateway 502 summary)', { reason: 'provider_error', httpStatus: 502, providerMessage: `${GATEWAY_SUMMARY_PREFIX}: needs key ×1, model unavailable ×4` }, 'no_upstream'],
    ['quota / rate limit', { reason: 'rate_limited', httpStatus: 429, providerMessage: 'Free usage limit reached' }, 'rate_limited'],
    ['credit exhausted', { reason: 'payment_required', httpStatus: 402, providerMessage: null }, 'rate_limited'],
    ['gateway key rejected during inference', { reason: 'provider_error', httpStatus: 401, providerMessage: 'Invalid API key' }, 'invalid_key'],
    ['missing credential', { reason: 'credential', httpStatus: null, providerMessage: null }, 'invalid_key'],
    ['model unavailable', { reason: 'model_unavailable', httpStatus: 400, providerMessage: 'no such model' }, 'model_unavailable'],
    ['timeout', { reason: 'provider_error', httpStatus: null, providerMessage: 'timeout' }, 'timeout'],
    ['gateway went down mid-check', { reason: 'provider_error', httpStatus: null, providerMessage: 'connection refused (nothing is listening at the provider address)' }, 'unreachable'],
    ['anything else', { reason: 'provider_error', httpStatus: 500, providerMessage: 'boom' }, 'inference_failed'],
  ] as const)('inference failure: %s', async (_name, attempt, state) => {
    expect(gatewayStateOfAttempt({ ...attempt })).toBe(state);
    gateway();
    const out = await checkOmniRouteGateway({ baseUrl: BASE, apiKey: KEY, infer: async () => ({ ok: false, attempt: { ...attempt } }) });
    expect(out.state).toBe(state);
    expect(out.layers).toMatchObject({ reachable: true, keyAccepted: true, inference: 'failed' });
  });

  it('the answer never contains the key', async () => {
    gateway();
    const out = await checkOmniRouteGateway({ baseUrl: BASE, apiKey: KEY, infer: async () => ({ ok: true }) });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });
});
