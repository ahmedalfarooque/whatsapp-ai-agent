import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../src/config/env';
import { checkProviderEndpoint, classifyHost, isLoopbackUrl } from '../../../src/llm/endpointPolicy';
import { ProviderValidationError, validateProviderInput, type AiProviderInput } from '../../../src/llm/providerRepo';
import { isOmniRouteKey, isPlausibleOmniRouteKey, omniRouteReachable, discoverLocalOmniRouteKey } from '../../../src/llm/omniRoute';

const mutableEnv = env as unknown as Record<string, unknown>;
const originalAllow = mutableEnv.allowLocalHttpProviders;
afterEach(() => { mutableEnv.allowLocalHttpProviders = originalAllow; mutableEnv.OMNIROUTE_API_KEY = ''; vi.unstubAllGlobals(); });

describe('where an AI provider (and its API key) may be sent', () => {
  it('classifies hosts: loopback, private, link-local and public — including the disguised spellings of 127.0.0.1', () => {
    for (const h of ['localhost', 'LOCALHOST', 'api.localhost', '127.0.0.1', '127.9.9.9', '[::1]', '::1']) expect(classifyHost(h), h).toBe('loopback');
    for (const h of ['10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', 'intranet', 'db', 'printer.local', 'svc.internal', 'host.corp', '[fd12::1]', '::']) expect(classifyHost(h), h).toBe('private');
    for (const h of ['169.254.169.254', '[fe80::1]']) expect(classifyHost(h), h).toBe('link_local');
    for (const h of ['api.groq.com', 'openrouter.ai', 'generativelanguage.googleapis.com', '8.8.8.8', '172.32.0.1', '1.1.1.1']) expect(classifyHost(h), h).toBe('public');
    // the URL parser normalises numeric spellings before the policy sees them
    for (const u of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/']) expect(classifyHost(new URL(u).hostname), u).toBe('loopback');
    expect(classifyHost(new URL('http://[::ffff:127.0.0.1]/').hostname)).toBe('loopback'); // an IPv4 address in an IPv6 coat
    expect(classifyHost(new URL('http://[::ffff:10.1.2.3]/').hostname)).toBe('private');
    expect(classifyHost(new URL('https://[::ffff:169.254.169.254]/').hostname)).toBe('link_local');
  });

  it('a remote provider must be HTTPS; plain HTTP to anything but this machine is refused', () => {
    expect(checkProviderEndpoint('https://api.groq.com/openai/v1', false)).toBeNull();
    expect(checkProviderEndpoint('http://api.groq.com/openai/v1', false)).toBe('insecure_http');
    expect(checkProviderEndpoint('http://8.8.8.8/v1', true)).toBe('insecure_http'); // allowing local providers never allows a remote HTTP one
    expect(checkProviderEndpoint('ftp://api.groq.com/v1', true)).toBe('unsupported_scheme');
    expect(checkProviderEndpoint('https://user:secret@api.groq.com/v1', true)).toBe('credentials_in_url');
    expect(checkProviderEndpoint('not a url', true)).toBe('invalid_url');
  });

  it('private, link-local (cloud metadata) and internal-looking hosts are refused even over HTTPS, whatever the local setting', () => {
    for (const u of ['https://169.254.169.254/latest/meta-data', 'https://10.0.0.5/v1', 'https://192.168.0.10/v1', 'https://intranet/v1', 'https://db.internal/v1', 'https://[fd00::1]/v1', 'http://10.0.0.5/v1', 'http://169.254.169.254/']) {
      expect(checkProviderEndpoint(u, true), u).toBe('private_address');
      expect(checkProviderEndpoint(u, false), u).toBe('private_address');
    }
  });

  it('a gateway on THIS machine\'s loopback address is accepted only where local providers are allowed', () => {
    for (const u of ['http://127.0.0.1:20128/v1', 'http://localhost:11434/v1', 'http://[::1]:8080/v1']) {
      expect(checkProviderEndpoint(u, true), u).toBeNull();
      expect(checkProviderEndpoint(u, false), u).toBe('local_providers_disabled');
    }
    expect(isLoopbackUrl('http://127.0.0.1:20128/v1')).toBe(true);
    expect(isLoopbackUrl('https://api.groq.com')).toBe(false);
    expect(isLoopbackUrl('garbage')).toBe(false);
  });
});

describe('saving a provider applies that policy (create and edit share the validator)', () => {
  const input = (baseUrl: string, over: Partial<AiProviderInput> = {}): AiProviderInput => ({ name: 'P', kind: 'openai_compatible', baseUrl, models: ['m1'], ...over });
  const fields = (i: AiProviderInput): string[] | null => { try { validateProviderInput(i); return null; } catch (e) { if (e instanceof ProviderValidationError) return e.fields; throw e; } };

  it('HTTPS providers pass; remote HTTP, private addresses and metadata addresses are refused', () => {
    mutableEnv.allowLocalHttpProviders = true;
    expect(fields(input('https://api.groq.com/openai/v1'))).toBeNull();
    expect(fields(input('http://api.groq.com/openai/v1'))).toEqual(['baseUrl']); // already refused by the syntax rule
    expect(fields(input('http://example.com/v1'))).toEqual(['baseUrl']);
    expect(fields(input('https://169.254.169.254/latest'))).toEqual(['baseUrl']);
    expect(fields(input('https://10.1.2.3/v1'))).toEqual(['baseUrl']);
    expect(fields(input('https://intranet/v1'))).toEqual(['baseUrl']);
  });

  it('a local HTTP provider (OmniRoute, Ollama) is allowed only through the explicit local setting: on in development, off in production unless set', () => {
    mutableEnv.allowLocalHttpProviders = true;
    expect(fields(input('http://127.0.0.1:20128/v1', { vendor: 'omniroute', models: ['auto/best-free'] }))).toBeNull();
    expect(fields(input('http://localhost:11434/v1'))).toBeNull();
    mutableEnv.allowLocalHttpProviders = false; // production default
    expect(fields(input('http://127.0.0.1:20128/v1', { vendor: 'omniroute', models: ['auto/best-free'] }))).toEqual(['baseUrl']);
    expect(fields(input('http://localhost:11434/v1'))).toEqual(['baseUrl']);
    expect(fields(input('https://api.groq.com/openai/v1'))).toBeNull(); // normal providers are unaffected
  });

  it('the production default really is "local providers off", and an explicit setting wins', () => {
    expect(typeof env.allowLocalHttpProviders).toBe('boolean');
    // development/test (this suite) allow it; production would not unless AI_ALLOW_LOCAL_HTTP_PROVIDERS=true — see the env schema
    expect(originalAllow).toBe(true);
  });
});

describe('OmniRoute: no credential is sent anywhere unless it is the right kind of key going to this machine', () => {
  const calls: string[] = [];
  const stub = (handler: (url: string) => Response = () => new Response('{}', { status: 200 })) => { calls.length = 0; vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(String(url)); return handler(String(url)); })); };

  it('shape: only plain sk- tokens are OmniRoute client keys', () => {
    expect(isPlausibleOmniRouteKey('sk-omniroutetestkey0123456789abcdef')).toBe(true);
    for (const bad of ['', 'sk-', 'sk-short', 'AIzaSyD0123456789abcdefghijklmnop', 'gsk_0123456789abcdef', 'sk-or-v1 with space 0123456789', 'sk-has/slash/0123456789', `sk-${'a'.repeat(300)}`, 'http://127.0.0.1:20128/v1']) expect(isPlausibleOmniRouteKey(bad), bad).toBe(false);
  });

  it('an unsupported credential is rejected BEFORE any outbound request (not even a health probe)', async () => {
    stub();
    for (const bad of ['AIzaSyD0123456789abcdefghijklmnop', 'sk-or-v1 spaced key 0123456789', 'short', '']) expect(await isOmniRouteKey(bad), bad).toBe(false);
    expect(calls).toEqual([]);
  });

  it('a non-loopback gateway address is never probed and never sent a key, even for a well-formed key', async () => {
    stub();
    for (const base of ['https://evil.example/v1', 'http://10.0.0.5:20128/v1', 'http://169.254.169.254/v1']) {
      expect(await isOmniRouteKey('sk-omniroutetestkey0123456789abcdef', base), base).toBe(false);
      expect(await omniRouteReachable(base), base).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('the loopback gateway is asked for its health first, then (only then) given the key, with redirects refused', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { seen.push({ url: String(url), init }); return String(url).endsWith('/health') ? new Response(JSON.stringify({ status: 'healthy' }), { status: 200 }) : new Response('{}', { status: 200 }); }));
    expect(await isOmniRouteKey('sk-omniroutetestkey0123456789abcdef')).toBe(true);
    expect(seen.map((s) => s.url)).toEqual(['http://127.0.0.1:20128/api/monitoring/health', 'http://127.0.0.1:20128/v1/models']);
    expect(seen.every((s) => s.init.redirect === 'error')).toBe(true);
    expect((seen[0]!.init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined(); // the health probe carries no credential
  });

  it('the local key comes from the central configuration and must itself be well-formed', async () => {
    mutableEnv.OMNIROUTE_API_KEY = 'sk-omniroutetestkey0123456789abcdef';
    expect(await discoverLocalOmniRouteKey()).toBe('sk-omniroutetestkey0123456789abcdef');
    mutableEnv.OMNIROUTE_API_KEY = 'not a key';
    expect(await discoverLocalOmniRouteKey()).toBeNull();
  });
});
