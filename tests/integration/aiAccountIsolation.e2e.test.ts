import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  markMessageAsRead: vi.fn().mockResolvedValue(undefined),
}));

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendTextMessage } from '../../src/whatsapp/client';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { setAccountFeature, FEATURES } from '../../src/accounts/accountFeatures';
import { updateBusinessSettings } from '../../src/config/businessSettings';
import { uploadCatalogue } from '../../src/catalogues/catalogueRepo';
import { searchCataloguesHandler } from '../../src/tools/searchCatalogues';
import { toolSchemasForAccount } from '../../src/tools';
import { loadKnowledgeBase } from '../../src/knowledge/loader';
import { knowledgeDirForAccount } from '../../src/knowledge/paths';
import { buildSystemPrompt } from '../../src/llm/buildSystemPrompt';
import { chatCompletion } from '../../src/llm/openRouterClient';
import { processInboundMessage, resetCredentialFallbackThrottle } from '../../src/pipeline/processInboundMessage';
import { getOrCreateCustomer, setCustomerLanguage } from '../../src/memory/customerRepo';
import { ensureProviderHealth, resetProviderHealthForTests } from '../../src/llm/aiProviderHealth';
import { getAiState } from '../../src/dashboard/overview';
import { makePdf } from '../fixtures/makePdf';

/**
 * The three businesses side by side: Alpha (account 1, calendar tools), Bravo (account 2, catalogue library) and Charlie (account 3,
 * nothing extra). Every account has its own model, tools, knowledge, customers' memory and catalogues; none may see another's.
 */
const mutableEnv = env as unknown as Record<string, unknown>;
const KEY = 'sk-or-v1-isolationisolationisolationisolation00000000';
const MARK = { 1: 'ALPHA-FACT-MARKER', 2: 'BRAVO-FACT-MARKER', 3: 'CHARLIE-FACT-MARKER' } as const;
const MODELS = { 1: 'vendor/alpha-model', 2: 'vendor/bravo-model', 3: 'vendor/charlie-model' } as const;
const originalMock = mutableEnv.shouldUseMockProviders;
const originalKey = mutableEnv.OPENROUTER_API_KEY;
const ids = [1, 2, 3] as const;

let legacyDir: string;
let accountsDir: string;
const saved = { legacy: process.env.KNOWLEDGE_LEGACY_DIR, accounts: process.env.KNOWLEDGE_ACCOUNTS_DIR };
const requests: Array<{ model: string; body: string; tools: string[] }> = [];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function stubProvider(reply = 'A grounded reply.') {
  requests.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ model: body.model, body: String(init.body), tools: (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name) });
    return json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: reply } }] });
  }));
}
const knowledgeOf = (id: number) => loadKnowledgeBase(knowledgeDirForAccount(id));

async function say(account: number, waId: string, text: string) {
  return runWithAccount(account, async () => {
    setCustomerLanguage(getOrCreateCustomer(waId, 'Sam').id, 'en');
    await processInboundMessage({ waId, messageId: `wamid.${crypto.randomUUID()}`, timestamp: Date.now(), type: 'text', text, contactName: 'Sam' } as never, { knowledge: knowledgeOf(account) });
  });
}

beforeAll(async () => {
  legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-legacy-'));
  accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-accounts-'));
  process.env.KNOWLEDGE_LEGACY_DIR = legacyDir;
  process.env.KNOWLEDGE_ACCOUNTS_DIR = accountsDir;
  getDb();
  expect(createAccount({ name: 'Bravo Paints' }).id).toBe(2);
  expect(createAccount({ name: 'Charlie Realty' }).id).toBe(3);
  expect(createAccount({ name: 'Delta Paints' }).id).toBe(4);
  for (const id of ids) {
    fs.mkdirSync(knowledgeDirForAccount(id), { recursive: true });
    fs.writeFileSync(path.join(knowledgeDirForAccount(id), 'business.md'), `# ${MARK[id]}\n${MARK[id]} is the business of account ${id} and serves its own customers only.\n`);
    updateBusinessSettings({ openRouterModel: MODELS[id] }, id);
  }
  setAccountFeature(2, FEATURES.CATALOGUES, true);
  setAccountFeature(4, FEATURES.CATALOGUES, true);
  await uploadCatalogue({ originalName: 'bravo.pdf', mimeType: 'application/pdf', bytes: makePdf(['Bravo Soulful Spaces', '1625 Soul warm neutral colour']), title: 'Bravo Soulful Spaces' }, 2);
  await uploadCatalogue({ originalName: 'delta.pdf', mimeType: 'application/pdf', bytes: makePdf(['Delta Nuances', '9001 Ocean deep blue colour']), title: 'Delta Nuances' }, 4);
  mutableEnv.shouldUseMockProviders = false;
  mutableEnv.OPENROUTER_API_KEY = KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(sendTextMessage).mockClear();
  resetCredentialFallbackThrottle();
  resetProviderHealthForTests();
});

afterAll(() => {
  mutableEnv.shouldUseMockProviders = originalMock;
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  fs.rmSync(legacyDir, { recursive: true, force: true });
  fs.rmSync(accountsDir, { recursive: true, force: true });
  for (const [key, value] of [['KNOWLEDGE_LEGACY_DIR', saved.legacy], ['KNOWLEDGE_ACCOUNTS_DIR', saved.accounts]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('model and tools are resolved per account', () => {
  it('each account\'s provider request carries its own model and only its own tools', async () => {
    stubProvider();
    for (const id of ids) await runWithAccount(id, () => chatCompletion({ messages: [{ role: 'user', content: 'hi' }], tools: toolSchemasForAccount(id) }));
    expect(requests.map((r) => r.model)).toEqual([MODELS[1], MODELS[2], MODELS[3]]);
    const [a, b, c] = requests.map((r) => new Set(r.tools));
    expect([...a!]).toEqual(expect.arrayContaining(['check_availability', 'book_appointment', 'request_human_handoff']));
    expect(a!.has('search_catalogues')).toBe(false);
    expect(b!.has('search_catalogues')).toBe(true);
    expect(b!.has('book_appointment')).toBe(false);
    expect(b!.has('check_availability')).toBe(false);
    expect(c!.has('request_human_handoff')).toBe(true);
    for (const forbidden of ['check_availability', 'book_appointment', 'search_catalogues']) expect(c!.has(forbidden)).toBe(false);
  });
});

describe('prompts and answers never carry another account\'s facts', () => {
  it('each account\'s prompt has only its own marker and the shared reply rules', () => {
    for (const id of ids) {
      const prompt = runWithAccount(id, () => buildSystemPrompt(knowledgeOf(id)));
      expect(prompt).toContain(MARK[id]);
      expect(prompt).toContain('HOW TO REPLY');
      for (const other of ids) if (other !== id) expect(prompt, `account ${id} prompt vs account ${other}`).not.toContain(MARK[other]);
    }
  });
});

describe('customer memory is per account AND per customer', () => {
  it('the same phone number talking to two businesses has two separate conversations: nothing crosses over', async () => {
    stubProvider();
    await say(1, '15557770001', 'ALPHA-ONLY-MESSAGE: I want an appointment for my car');
    const alphaRequest = requests.at(-1)!;
    expect(alphaRequest.body).toContain('ALPHA-ONLY-MESSAGE');
    expect(alphaRequest.body).toContain(MARK[1]);

    await say(2, '15557770001', 'BRAVO-ONLY-MESSAGE: do you have warm neutral colours?');
    const bravoRequest = requests.at(-1)!;
    expect(bravoRequest.body).toContain('BRAVO-ONLY-MESSAGE');
    expect(bravoRequest.body).toContain(MARK[2]);
    expect(bravoRequest.body).not.toContain('ALPHA-ONLY-MESSAGE');
    expect(bravoRequest.body).not.toContain(MARK[1]);
    expect(bravoRequest.model).toBe(MODELS[2]);

    // A second message in Alpha still sees only Alpha's own earlier turn, never Bravo's.
    await say(1, '15557770001', 'ALPHA-FOLLOW-UP: and on Saturday?');
    const followUp = requests.at(-1)!;
    expect(followUp.body).toContain('ALPHA-ONLY-MESSAGE');
    expect(followUp.body).toContain('ALPHA-FOLLOW-UP');
    expect(followUp.body).not.toContain('BRAVO-ONLY-MESSAGE');

    const rows = getDb().prepare('SELECT whatsapp_account_id AS a, COUNT(*) AS n FROM customers WHERE wa_id = ? GROUP BY whatsapp_account_id ORDER BY a').all('15557770001');
    expect(rows).toEqual([{ a: 1, n: 1 }, { a: 2, n: 1 }]);
  });

  it('a different customer of the same business never sees another customer\'s messages', async () => {
    stubProvider();
    await say(2, '15557770002', 'PRIVATE-CUSTOMER-ONE: my address is 12 Palm Street');
    await say(2, '15557770003', 'What colours do you have?');
    expect(requests.at(-1)!.body).not.toContain('PRIVATE-CUSTOMER-ONE');
    expect(requests.at(-1)!.body).not.toContain('Palm Street');
  });
});

describe('catalogue retrieval is per account', () => {
  it('a business finds only its own catalogue passages; a business without the library finds nothing', async () => {
    const own = (await runWithAccount(2, () => searchCataloguesHandler({ query: '1625 Soul' }))) as { results: Array<{ title: string }> };
    expect(own.results.length).toBeGreaterThan(0);
    expect(own.results.every((r) => r.title.includes('Bravo'))).toBe(true);

    const other = (await runWithAccount(4, () => searchCataloguesHandler({ query: '1625 Soul' }))) as { results: unknown[] };
    expect(other.results).toEqual([]); // Delta has a library of its own, but not Bravo's colour
    const delta = (await runWithAccount(4, () => searchCataloguesHandler({ query: '9001 Ocean' }))) as { results: Array<{ title: string }> };
    expect(delta.results.every((r) => r.title.includes('Delta'))).toBe(true);
    const bravoSeesDelta = (await runWithAccount(2, () => searchCataloguesHandler({ query: '9001 Ocean' }))) as { results: unknown[] };
    expect(bravoSeesDelta.results).toEqual([]);

    const plain = (await runWithAccount(3, () => searchCataloguesHandler({ query: '1625 Soul' }))) as { results: unknown[] };
    expect(plain.results).toEqual([]);
  });
});

describe('provider health checks never change account data', () => {
  it('probing the key and every account\'s model and reading the AI status leaves every account-scoped table and the credentials untouched', async () => {
    const fingerprint = (): string => {
      const db = getDb();
      const tables = (db.prepare("SELECT m.name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND p.name='whatsapp_account_id' ORDER BY m.name").all() as Array<{ name: string }>).map((t) => t.name);
      const parts = tables.map((t) => `${t}:${crypto.createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM "${t}" ORDER BY 1`).all())).digest('hex')}`);
      parts.push(`settings:${crypto.createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM business_settings ORDER BY id').all())).digest('hex')}`);
      parts.push(`credentials:${crypto.createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM credential_overrides ORDER BY key').all())).digest('hex')}`);
      return parts.join('|');
    };
    stubProvider('ok');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('/auth/key') ? json(200, { data: {} }) : json(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] }))));
    const before = fingerprint();
    for (const id of ids) await ensureProviderHealth(2000, MODELS[id]);
    for (const id of ids) getAiState(id);
    expect(fingerprint()).toBe(before);
  });
});
