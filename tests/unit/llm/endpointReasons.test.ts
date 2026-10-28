import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../../../src/config/env';
import { checkProviderEndpoint, describeEndpointRefusal, normalizeProviderBaseUrl } from '../../../src/llm/endpointPolicy';
import { ProviderValidationError, validateProviderInput, type AiProviderInput } from '../../../src/llm/providerRepo';
import { discoverModels } from '../../../src/llm/modelDiscovery';

const mutableEnv = env as unknown as Record<string, unknown>;
const originalAllow = mutableEnv.allowLocalHttpProviders;
afterEach(() => { mutableEnv.allowLocalHttpProviders = originalAllow; });

const input = (baseUrl: string, over: Partial<AiProviderInput> = {}): AiProviderInput => ({ name: 'OmniRoute', kind: 'openai_compatible', baseUrl, models: ['auto/best-free'], ...over });
const reasonOf = (i: AiProviderInput): { fields: string[]; reasons: Record<string, string> } | null => {
  try { validateProviderInput(i); return null; } catch (e) { if (e instanceof ProviderValidationError) return { fields: e.fields, reasons: e.reasons }; throw e; }
};

describe('why an endpoint was refused is named, not "Check baseUrl"', () => {
  it('a valid loopback gateway address says it is the local-providers switch, and names the setting to change', () => {
    mutableEnv.allowLocalHttpProviders = false; // production default
    const out = reasonOf(input('http://127.0.0.1:20128/v1', { vendor: 'omniroute' }));
    expect(out?.fields).toEqual(['baseUrl']);
    expect(out?.reasons.baseUrl).toMatch(/local providers are switched off/);
    expect(out?.reasons.baseUrl).toMatch(/AI_ALLOW_LOCAL_HTTP_PROVIDERS=true/);
    expect(out?.reasons.baseUrl).toMatch(/loopback addresses only/);
  });

  it('every refusal code has its own wording, and none of them contains a key or a stack', () => {
    const codes = ['invalid_url', 'credentials_in_url', 'unsupported_scheme', 'insecure_http', 'private_address', 'local_providers_disabled'] as const;
    const texts = codes.map(describeEndpointRefusal);
    expect(new Set(texts).size).toBe(codes.length);
    for (const t of texts) expect(t).not.toMatch(/sk-|Error:|\bat \w+\(/);
  });

  it('syntax failures and remote plain http are told apart', () => {
    mutableEnv.allowLocalHttpProviders = true;
    expect(reasonOf(input('not a url'))?.reasons.baseUrl).toMatch(/not a valid URL/);
    expect(reasonOf(input('http://example.com/v1'))?.reasons.baseUrl).toMatch(/must use https/);
    expect(reasonOf(input('https://10.1.2.3/v1'))?.reasons.baseUrl).toMatch(/Private, internal/);
    expect(reasonOf(input('https://api.groq.com/openai/v1', { vendor: 'openai' }))?.reasons.baseUrl).toMatch(/official API address/);
  });
});

describe('loopback permission never widens the policy', () => {
  it('with local providers allowed, only loopback is added: private, link-local, metadata and look-alike hosts stay refused', () => {
    for (const url of ['http://10.0.0.5:20128/v1', 'http://192.168.1.10/v1', 'http://169.254.169.254/v1', 'http://127.0.0.1.evil.com/v1', 'http://localhost.evil.com/v1', 'http://example.com:20128/v1', 'http://user:pw@127.0.0.1/v1']) {
      expect(checkProviderEndpoint(url, true), url).not.toBeNull();
    }
    expect(checkProviderEndpoint('http://127.0.0.1:20128/v1', true)).toBeNull();
    expect(checkProviderEndpoint('http://[::1]:20128/v1', true)).toBeNull();
  });

  it('saving with local providers ON still refuses an external http address, and the loopback gateway passes', () => {
    mutableEnv.allowLocalHttpProviders = true;
    for (const url of ['http://example.com:20128/v1', 'http://130.110.112.192:20128/v1', 'http://10.0.0.5:20128/v1']) {
      expect(reasonOf(input(url))?.fields, url).toEqual(['baseUrl']);
    }
    expect(reasonOf(input('http://127.0.0.1:20128/v1', { vendor: 'omniroute' }))).toBeNull();
  });
});

describe('one spelling of the address for save, Load models, test and inference', () => {
  it('trims and drops trailing slashes and changes nothing else (the host as typed, localhost included, is kept)', () => {
    expect(normalizeProviderBaseUrl('  http://localhost:20128/v1/ ')).toBe('http://localhost:20128/v1');
    expect(normalizeProviderBaseUrl('http://127.0.0.1:20128/v1')).toBe('http://127.0.0.1:20128/v1');
    expect(normalizeProviderBaseUrl('https://api.groq.com/openai/v1//')).toBe('https://api.groq.com/openai/v1');
    expect(normalizeProviderBaseUrl('garbage/')).toBe('garbage');
  });

  it('model discovery applies the same normalisation and the same policy and names the refusal', async () => {
    const calls: string[] = [];
    const fetcher = async (url: string) => { calls.push(url); return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }); };
    const off = await discoverModels({ vendor: 'custom', apiKey: 'sk-test-1234567890', baseUrl: 'http://localhost:11434/v1/' }, { fetch: fetcher, allowLocal: false });
    expect(off).toMatchObject({ ok: false, reason: 'endpoint_refused' });
    expect((off as { message: string }).message).toMatch(/local providers are switched off/);
    expect(calls).toHaveLength(0); // refused before any request, so the key was never sent
    const on = await discoverModels({ vendor: 'custom', apiKey: 'sk-test-1234567890', baseUrl: 'http://localhost:11434/v1/' }, { fetch: fetcher, allowLocal: true });
    expect(on.ok).toBe(true);
    expect(calls[0]).toBe('http://localhost:11434/v1/models'); // trailing slash normalised, host kept
  });
});
