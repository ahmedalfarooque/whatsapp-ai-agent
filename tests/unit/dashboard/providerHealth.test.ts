import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../../src/config/env')>('../../../src/config/env');
  return { ...actual, env: { ...actual.env, shouldUseMockProviders: false, OPENROUTER_FALLBACK_MODELS: '', AI_ROUTING_BUDGET_MS: 6000, AI_ROUTE_MAX_ATTEMPTS: 4 } };
});

import { env } from '../../../src/config/env';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { providerHealth } from '../../../src/dashboard/aiPoolState';
import { createProvider, recordProviderTest, type AiProviderRow } from '../../../src/llm/providerRepo';
import { allowUnknownPriceForTests, buildCandidates, resetAiRouterForTests, routeCompletion } from '../../../src/llm/aiRouter';
import { quotaResetDelayMs } from '../../../src/llm/openAiCompatible';
import { setModelCatalogForTests } from '../../../src/llm/modelCatalog';

const mutableEnv = env as unknown as Record<string, unknown>;
const KEY = 'sk-or-v1-healthhealthhealthhealthhealthhealth0000000000';
const GROQ = 'gsk_groqgroqgroqgroqgroqgroqgroqgroq000000000';
const NOW = Date.parse('2026-10-18T12:00:00Z');
const at = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const originalKey = mutableEnv.OPENROUTER_API_KEY;
const get = (id: number): AiProviderRow => getDb().prepare('SELECT * FROM ai_providers WHERE id = ?').get(id) as AiProviderRow;
const orProvider = () => createProvider({ name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY, models: ['openrouter/free'], timeoutMs: 3000 }, { accountId: null, updatedBy: 1 }).id;
const logRow = (id: number, outcome: 'ok' | 'failed', category: string | null, http: number | null, detail: string | null, atMs: number, model = 'openrouter/free'): void => {
  getDb().prepare('INSERT INTO ai_route_log (whatsapp_account_id, task, provider_id, provider_name, model, outcome, category, http_status, latency_ms, detail, created_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 50, ?, ?)').run('chat', id, 'OpenRouter', model, outcome, category, http, detail, at(atMs));
};

beforeEach(() => {
  getDb();
  getDb().prepare('DELETE FROM ai_providers').run();
  getDb().prepare('DELETE FROM ai_route_log').run();
  setModelCatalogForTests([{ id: 'openrouter/free', free: true, image: false, audio: false, tools: true, contextLength: 100000 }]);
  allowUnknownPriceForTests(false);
  resetAiRouterForTests();
  mutableEnv.OPENROUTER_API_KEY = '';
});
afterEach(() => { vi.unstubAllGlobals(); mutableEnv.OPENROUTER_API_KEY = originalKey; });

describe('per-provider health states (facts only, never "a key is saved")', () => {
  it('off, no key, no model, not eligible, untested, test passed, test failed', () => {
    const id = orProvider();
    expect(providerHealth(get(id), NOW)).toMatchObject({ state: 'untested' });
    recordProviderTest(id, true, 'Model openrouter/free answered in 1.8 s.');
    expect(providerHealth(get(id), NOW)).toMatchObject({ state: 'available', label: 'Available' });
    expect(providerHealth(get(id), NOW).summary).toContain('no customer request has used it yet');
    recordProviderTest(id, false, 'model unavailable, HTTP 404');
    expect(providerHealth(get(id), NOW)).toMatchObject({ state: 'request_failed', label: 'Test failed' });
    getDb().prepare('UPDATE ai_providers SET enabled = 0 WHERE id = ?').run(id);
    expect(providerHealth(get(id), NOW)).toMatchObject({ state: 'off' });
    getDb().prepare('UPDATE ai_providers SET enabled = 1, key_ciphertext = NULL WHERE id = ?').run(id);
    expect(providerHealth(get(id), NOW)).toMatchObject({ state: 'no_key' });
    getDb().prepare("UPDATE ai_providers SET models = '' WHERE id = ?").run(id);
    getDb().prepare('UPDATE ai_providers SET key_ciphertext = (SELECT key_ciphertext FROM ai_providers WHERE 0) WHERE 0').run();
    const g = createProvider({ name: 'Groq', kind: 'openai_compatible', adapter: 'openai', vendor: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ, models: ['openai/gpt-oss-20b'], freeConfirmed: false }, { accountId: null, updatedBy: 1 }).id;
    expect(providerHealth(get(g), NOW)).toMatchObject({ state: 'ineligible', label: 'Not eligible' });
    expect(providerHealth(get(g), NOW).summary).toContain('Free tier not confirmed');
    getDb().prepare("UPDATE ai_providers SET free_confirmed = 1, models = '' WHERE id = ?").run(g);
    expect(providerHealth(get(g), NOW)).toMatchObject({ state: 'config_error', label: 'Configuration error' });
  });

  it('a successful inference from the routing history is shown with its time and model', () => {
    const id = orProvider();
    logRow(id, 'ok', null, null, null, NOW - 10 * 60_000);
    const h = providerHealth(get(id), NOW);
    expect(h).toMatchObject({ state: 'ok', label: 'Successful inference' });
    expect(h.summary).toBe('Answered at 11:50 UTC · openrouter/free');
  });

  it.each([
    ['auth', 401, 'Invalid credentials', 'invalid_credentials'],
    ['rate_limited', 429, 'Rate limited / quota exhausted', 'rate_limited'],
    ['credit', 402, 'Rate limited / quota exhausted', 'rate_limited'],
    ['model_unavailable', 404, 'Configuration error', 'config_error'],
    ['policy', 404, 'Configuration error', 'config_error'],
    ['timeout', null, 'Request failed', 'request_failed'],
    ['provider_error', 503, 'Request failed', 'request_failed'],
    ['empty', 200, 'Request failed', 'request_failed'],
  ])('latest failure %s (HTTP %s) after its cooldown → %s', (category, http, label, state) => {
    const id = orProvider();
    logRow(id, 'failed', category, http, 'sanitized reason', NOW - 60 * 60_000);
    expect(providerHealth(get(id), NOW)).toMatchObject({ state, label });
  });

  it('while a cooldown is active the card says so, with the time the provider is eligible again (quota vs other)', async () => {
    const id = orProvider();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day' } }), { status: 429 })));
    const acc = createAccount({ name: `Health Co ${Math.random()}` }).id;
    await expect(runWithAccount(acc, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, deadline: Date.now() + 5000 }))).rejects.toBeTruthy();
    const h = providerHealth(get(id));
    expect(h).toMatchObject({ state: 'rate_limited', label: 'Rate limited / quota exhausted' });
    expect(h.summary).toMatch(/eligible again at \d\d:\d\d UTC/);
    expect(h.detail).toContain('No request is sent to this provider until');
    expect(h.summary.length).toBeLessThanOrEqual(100);
  });

  it('no secret reaches the card text', () => {
    const id = orProvider();
    logRow(id, 'failed', 'auth', 401, `echo ${KEY}`, NOW - 3_600_000);
    expect(JSON.stringify(providerHealth(get(id), NOW))).not.toContain(KEY);
  });
});

describe('the provider\'s published quota-reset time is respected', () => {
  it('parses X-RateLimit-Reset (ms or s epoch, header or error metadata) only when believable', () => {
    const now = 1_800_000_000_000;
    expect(quotaResetDelayMs(String(now + 3_600_000), undefined, now)).toBe(3_600_000);
    expect(quotaResetDelayMs(String((now + 7_200_000) / 1000), undefined, now)).toBe(7_200_000);
    expect(quotaResetDelayMs(null, JSON.stringify({ error: { metadata: { headers: { 'X-RateLimit-Reset': String(now + 5_000_000) } } } }), now)).toBe(5_000_000);
    expect(quotaResetDelayMs(String(now - 10_000), undefined, now)).toBeNull(); // already past
    expect(quotaResetDelayMs(String(now + 30 * 3_600_000), undefined, now)).toBeNull(); // implausibly far
    expect(quotaResetDelayMs('60', undefined, now)).toBeNull(); // a bare number is not an epoch
    expect(quotaResetDelayMs('garbage', '{not json', now)).toBeNull();
  });

  it('a 429 with a reset time rests the provider until then (longer than the default), and no call is made meanwhile', async () => {
    orProvider();
    const acc = createAccount({ name: `Reset Co ${Math.random()}` }).id;
    const reset = Date.now() + 3 * 3_600_000;
    const spy = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day', metadata: { headers: { 'X-RateLimit-Reset': String(reset) } } } }), { status: 429 }));
    vi.stubGlobal('fetch', spy);
    await expect(runWithAccount(acc, () => routeCompletion({ task: 'chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 8, deadline: Date.now() + 5000 }))).rejects.toBeTruthy();
    const calls = spy.mock.calls.length;
    expect((await runWithAccount(acc, () => buildCandidates(acc, 'chat', { wantsTools: false, now: Date.now() + 2 * 3_600_000 }))).eligible).toHaveLength(0);
    expect(spy.mock.calls.length).toBe(calls);
  });
});

describe('the provider card layout (responsive, no squeezed column)', () => {
  const root = path.join(__dirname, '../../../dashboard');
  const css = fs.readFileSync(path.join(root, 'ui.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const row = app.slice(app.indexOf('function aiEntryRowHtml'), app.indexOf('function readAiForm'));
  const block = css.slice(css.indexOf('.ai-entry {'), css.indexOf('.ai-more { margin-top'));

  it('uses named grid areas: identity and status side by side, the six controls on their own aligned row', () => {
    expect(block).toMatch(/grid-template-areas: "pos main state" "pos actions actions"/);
    expect(block).toMatch(/\.ai-actions \{[^}]*flex-wrap: wrap[^}]*justify-content: flex-start/);
    for (const act of ['up', 'down', 'test', 'toggle', 'edit', 'remove']) expect(row).toContain(`data-act="${act}"`);
  });

  it('the status is a badge plus ONE summary line (ellipsis), with the full diagnostic in an expandable Details and the tooltip', () => {
    expect(block).toMatch(/\.ai-summary \{[^}]*text-overflow: ellipsis[^}]*white-space: nowrap/);
    expect(block).toMatch(/\.ai-more-detail p \{[^}]*overflow-wrap: anywhere/);
    expect(row).toContain('<details class="ai-more-detail"><summary');
    expect(row).toContain('title="${esc(full || summary)}"');
    expect(row).not.toContain('shortText(entry.detail, 90)');
  });

  it('on a phone the card stacks (identity, status, controls), the summary may wrap to two lines, and nothing forces horizontal overflow', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 760px) {\n  .ai-entry') >= 0 ? css.indexOf('@media (max-width: 760px) {\n  .ai-entry') : css.indexOf('@media (max-width: 760px) {\r\n  .ai-entry'));
    expect(mobile).toMatch(/grid-template-areas: "pos main" "state state" "actions actions"/);
    expect(mobile).toMatch(/-webkit-line-clamp: 2/);
    expect(block).toMatch(/\.ai-entry \{[^}]*min-width: 0/);
    expect(block).not.toMatch(/\.ai-actions \{[^}]*nowrap/);
  });

  it('both lists pass the server health to the card (Super Admin and each business)', () => {
    expect(app).toMatch(/models: p\.models, health: p\.health/);
    expect(app).toContain('aiHealthBadge(health)');
    for (const tone of ['rate_limited', 'cooling', 'invalid_credentials', 'config_error', 'request_failed', 'ineligible', 'ok', 'available', 'untested', 'off', 'no_key']) expect(app).toContain(`${tone}:`);
  });
});
