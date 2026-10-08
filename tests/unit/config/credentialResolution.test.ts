import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { env } from '../../../src/config/env';
import { logger } from '../../../src/logger';
import { setSecret, getSecret, readOverride, encryptWithKey, resetUndecryptableWarnings } from '../../../src/config/secretStore';
import { describeCredential, getEffectiveCredential, isUsableApiKey } from '../../../src/config/effectiveConfig';
import { deriveKeyFromRawValue } from '../../../src/config/masterKey';
import { createAdminUser } from '../../../src/dashboard/auth';
import { chatCompletion } from '../../../src/llm/openRouterClient';
import { AiCredentialError } from '../../../src/llm/aiCredentialError';
import { getIntegrations } from '../../../src/dashboard/data';

const OTHER_KEY = deriveKeyFromRawValue('b'.repeat(64));
const GOOD_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef';
const STALE_SECRET = 'sk-or-v1-STALE-SECRET-VALUE-THAT-MUST-NEVER-LEAK-0000';
const mutableEnv = env as unknown as Record<string, unknown>;

let adminId: number;

/** Writes a row exactly as an earlier, different master key would have left it. */
function storeUnderOtherKey(key: string, plaintext: string): void {
  getDb()
    .prepare(`INSERT INTO credential_overrides (key, ciphertext, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?) ON CONFLICT(key) DO UPDATE SET ciphertext = excluded.ciphertext`)
    .run(key, encryptWithKey(plaintext, OTHER_KEY), adminId);
}

const logged = (spy: ReturnType<typeof vi.spyOn>) => JSON.stringify(spy.mock.calls);

beforeAll(() => {
  getDb();
  adminId = createAdminUser('cred-admin', 'a-very-long-test-password-123');
});

beforeEach(() => {
  getDb().prepare('DELETE FROM credential_overrides').run();
  resetUndecryptableWarnings();
});

describe('reading a stored override never throws on a stale row', () => {
  it('reports absent / ok / undecryptable', () => {
    expect(readOverride('OPENROUTER_API_KEY')).toEqual({ status: 'absent' });
    setSecret('OPENROUTER_API_KEY', GOOD_KEY, adminId);
    expect(readOverride('OPENROUTER_API_KEY')).toEqual({ status: 'ok', value: GOOD_KEY });
    storeUnderOtherKey('OPENROUTER_API_KEY', STALE_SECRET);
    expect(readOverride('OPENROUTER_API_KEY')).toEqual({ status: 'undecryptable' });
  });

  it('never returns the stale ciphertext or plaintext, and keeps the row (it is not deleted)', () => {
    storeUnderOtherKey('OPENROUTER_API_KEY', STALE_SECRET);
    expect(JSON.stringify(readOverride('OPENROUTER_API_KEY'))).not.toContain('STALE');
    expect((getDb().prepare('SELECT COUNT(*) n FROM credential_overrides').get() as { n: number }).n).toBe(1);
  });

  it('logs the stale key by NAME only, once per key, with no secret material', () => {
    const warn = vi.spyOn(logger, 'warn');
    storeUnderOtherKey('OPENROUTER_API_KEY', STALE_SECRET);
    const ciphertext = (getDb().prepare('SELECT ciphertext FROM credential_overrides').get() as { ciphertext: string }).ciphertext;
    readOverride('OPENROUTER_API_KEY');
    readOverride('OPENROUTER_API_KEY');
    readOverride('OPENROUTER_API_KEY');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged(warn)).toContain('OPENROUTER_API_KEY');
    expect(logged(warn)).not.toContain('STALE');
    expect(logged(warn)).not.toContain(ciphertext);
    warn.mockRestore();
  });

  it('getSecret itself stays strict: asking for the value of an undecryptable row still throws', () => {
    storeUnderOtherKey('OPENROUTER_API_KEY', STALE_SECRET);
    expect(() => getSecret('OPENROUTER_API_KEY')).toThrow();
  });
});

describe('effective credential resolution', () => {
  const original = env.OPENROUTER_API_KEY;
  afterEach(() => { mutableEnv.OPENROUTER_API_KEY = original; });

  it('a readable override wins over .env', () => {
    mutableEnv.OPENROUTER_API_KEY = 'sk-or-v1-from-env-0000000000000000';
    setSecret('OPENROUTER_API_KEY', GOOD_KEY, adminId);
    expect(getEffectiveCredential('OPENROUTER_API_KEY')).toBe(GOOD_KEY);
    expect(describeCredential('OPENROUTER_API_KEY')).toEqual({ key: 'OPENROUTER_API_KEY', source: 'override', overrideStatus: 'ok', envSet: true });
  });

  it('an undecryptable override is ignored and the .env value is used instead — nothing is thrown', () => {
    mutableEnv.OPENROUTER_API_KEY = 'sk-or-v1-from-env-0000000000000000';
    storeUnderOtherKey('OPENROUTER_API_KEY', STALE_SECRET);
    expect(getEffectiveCredential('OPENROUTER_API_KEY')).toBe('sk-or-v1-from-env-0000000000000000');
    expect(describeCredential('OPENROUTER_API_KEY')).toMatchObject({ source: 'env', overrideStatus: 'undecryptable' });
  });

  it('with nothing usable the value is empty (never the stale one) and the source is unset', () => {
    mutableEnv.OPENROUTER_API_KEY = '';
    storeUnderOtherKey('OPENROUTER_API_KEY', STALE_SECRET);
    expect(getEffectiveCredential('OPENROUTER_API_KEY')).toBe('');
    expect(describeCredential('OPENROUTER_API_KEY')).toMatchObject({ source: 'unset', overrideStatus: 'undecryptable', envSet: false });
  });

  it('re-entering the key replaces the stale row with one encrypted under the CURRENT master key', () => {
    storeUnderOtherKey('OPENROUTER_API_KEY', STALE_SECRET);
    expect(readOverride('OPENROUTER_API_KEY').status).toBe('undecryptable');
    setSecret('OPENROUTER_API_KEY', GOOD_KEY, adminId); // what POST /api/dashboard/ai/configure does
    expect(readOverride('OPENROUTER_API_KEY')).toEqual({ status: 'ok', value: GOOD_KEY });
    expect(getEffectiveCredential('OPENROUTER_API_KEY')).toBe(GOOD_KEY);
  });

  it('other stale keys do not affect an unrelated one', () => {
    storeUnderOtherKey('GOOGLE_CLIENT_EMAIL', 'old@example.iam.gserviceaccount.com');
    setSecret('OPENROUTER_API_KEY', GOOD_KEY, adminId);
    expect(getEffectiveCredential('OPENROUTER_API_KEY')).toBe(GOOD_KEY);
    expect(() => getEffectiveCredential('GOOGLE_CLIENT_EMAIL')).not.toThrow();
  });
});

describe('isUsableApiKey', () => {
  it('accepts a plausible key and rejects empty, spaced, quoted, multi-line, over-long and too-short values', () => {
    expect(isUsableApiKey(GOOD_KEY)).toBe(true);
    for (const bad of ['', '   ', 'short', `${GOOD_KEY} # comment`, `"${GOOD_KEY}"`, `'${GOOD_KEY}'`, `${GOOD_KEY}\nsecond`, 'x'.repeat(269), 'sk-or-v1-ключ-000000000000000', undefined, null]) {
      expect(isUsableApiKey(bad as string)).toBe(false);
    }
  });
});

describe('the OpenRouter client never sends an unusable key, and reports credential problems clearly', () => {
  const originalFetch = globalThis.fetch;
  const originalMock = env.shouldUseMockProviders;
  const originalKey = env.OPENROUTER_API_KEY;
  let fetchMock: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mutableEnv.shouldUseMockProviders = false;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    errorSpy = vi.spyOn(logger, 'error');
    warnSpy = vi.spyOn(logger, 'warn');
  });
  afterEach(() => {
    mutableEnv.shouldUseMockProviders = originalMock;
    mutableEnv.OPENROUTER_API_KEY = originalKey;
    vi.stubGlobal('fetch', originalFetch);
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const ask = () => chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

  it('no key at all: a clear "missing" error and no network call', async () => {
    mutableEnv.OPENROUTER_API_KEY = '';
    await expect(ask()).rejects.toMatchObject({ name: 'AiCredentialError', reason: 'missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a malformed .env key behind an undecryptable override: never sent, a clear "malformed" error, no secret in the logs', async () => {
    mutableEnv.OPENROUTER_API_KEY = `${GOOD_KEY} ${'z'.repeat(220)}`;
    storeUnderOtherKey('OPENROUTER_API_KEY', STALE_SECRET);
    await expect(ask()).rejects.toMatchObject({ reason: 'malformed' });
    expect(fetchMock).not.toHaveBeenCalled();
    for (const spy of [errorSpy, warnSpy]) {
      expect(logged(spy)).not.toContain('STALE');
      expect(logged(spy)).not.toContain(GOOD_KEY);
      expect(logged(spy)).not.toContain('zzzzzzzzzz');
    }
  });

  it('an undecryptable override with a good .env key: the .env key is sent, the stale value never is', async () => {
    mutableEnv.OPENROUTER_API_KEY = GOOD_KEY;
    storeUnderOtherKey('OPENROUTER_API_KEY', STALE_SECRET);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }), { status: 200 }));
    const out = await ask();
    expect(out.choices[0]!.message.content).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe(`Bearer ${GOOD_KEY}`);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('STALE');
  });

  it('a key OpenRouter refuses (401): ONE request, no retries, a clear "rejected" error, logged without the key', async () => {
    mutableEnv.OPENROUTER_API_KEY = GOOD_KEY;
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"No auth credentials found"}}', { status: 401 }));
    const failure = await ask().catch((e) => e);
    expect(failure).toBeInstanceOf(AiCredentialError);
    expect(failure).toMatchObject({ reason: 'rejected', httpStatus: 401 });
    expect(String(failure.message)).not.toContain(GOOD_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    expect(logged(errorSpy)).toContain('OPENROUTER_API_KEY');
    expect(logged(errorSpy)).not.toContain(GOOD_KEY);
  });

  it('403 is treated the same way', async () => {
    mutableEnv.OPENROUTER_API_KEY = GOOD_KEY;
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(ask()).rejects.toMatchObject({ reason: 'rejected', httpStatus: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the dashboard reports the true state of the AI key', () => {
  const originalMock = env.shouldUseMockProviders;
  const originalKey = env.OPENROUTER_API_KEY;
  afterEach(() => { mutableEnv.shouldUseMockProviders = originalMock; mutableEnv.OPENROUTER_API_KEY = originalKey; });
  const openRouter = () => getIntegrations().find((i) => i.name === 'OpenRouter')!;

  it('"Needs a new key" when the saved key is unreadable and nothing usable remains; "Configured" once a good key is entered', () => {
    mutableEnv.shouldUseMockProviders = false;
    mutableEnv.OPENROUTER_API_KEY = 'x'.repeat(269);
    storeUnderOtherKey('OPENROUTER_API_KEY', STALE_SECRET);
    expect(openRouter()).toMatchObject({ state: 'Needs a new key', configured: false });
    expect(openRouter().detail).toMatch(/enter it again/i);
    setSecret('OPENROUTER_API_KEY', GOOD_KEY, adminId);
    expect(openRouter()).toMatchObject({ state: 'Configured', configured: true });
  });

  it('"Missing configuration" when there is simply no key', () => {
    mutableEnv.shouldUseMockProviders = false;
    mutableEnv.OPENROUTER_API_KEY = '';
    expect(openRouter()).toMatchObject({ state: 'Missing configuration', configured: false });
  });
});
