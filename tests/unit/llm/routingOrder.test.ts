import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { createProvider, deleteProvider } from '../../../src/llm/providerRepo';
import { DEFAULT_ENTRY, getAccountRouting, providerEntryKey, RoutingOrderError, saveAccountRouting } from '../../../src/llm/routingOrder';
import { detectPresetId, resolveSimpleProvider, SimpleProviderError } from '../../../src/llm/providerPresets';

const own = (accountId: number, name: string, priority = 100) => createProvider({ name, kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_unitunitunitunitunitunit0000000000', models: ['m'], priority }, { accountId, updatedBy: 1 }).id;

describe('per-business routing order', () => {
  it('a new business starts with Default only; its own providers join after it; the order is persisted', () => {
    getDb();
    const a = createAccount({ name: 'Order A' }).id;
    expect(getAccountRouting(a).map((e) => e.key)).toEqual([DEFAULT_ENTRY]);
    const p1 = own(a, 'one');
    const p2 = own(a, 'two');
    expect(getAccountRouting(a).map((e) => e.key)).toEqual([DEFAULT_ENTRY, providerEntryKey(p1), providerEntryKey(p2)]);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM ai_account_routing WHERE whatsapp_account_id = ?').get(a)).toEqual({ n: 3 }); // explicit rows, not just computed
  });

  it('saving puts the chosen entries first, keeps the rest in their usual order, and persists the on/off switch', () => {
    const a = createAccount({ name: 'Order B' }).id;
    const p1 = own(a, 'one');
    const p2 = own(a, 'two');
    const saved = saveAccountRouting(a, [{ key: providerEntryKey(p2) }, { key: DEFAULT_ENTRY, enabled: false }], 1);
    expect(saved.map((e) => [e.key, e.enabled, e.position])).toEqual([[providerEntryKey(p2), true, 1], [DEFAULT_ENTRY, false, 2], [providerEntryKey(p1), true, 3]]);
    expect(getAccountRouting(a)).toEqual(saved);
  });

  it('refuses entries that are not this business\'s own (another business\'s provider, a shared one, a typo, a duplicate)', () => {
    const a = createAccount({ name: 'Order C' }).id;
    const b = createAccount({ name: 'Order D' }).id;
    const foreign = own(b, 'theirs');
    const shared = createProvider({ name: 'shared', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_unitunitunitunitunitunit0000000000', models: ['m'] }, { accountId: null, updatedBy: 1 }).id;
    for (const bad of [[{ key: providerEntryKey(foreign) }], [{ key: providerEntryKey(shared) }], [{ key: 'provider:abc' }], [{ key: 'nonsense' }]]) {
      expect(() => saveAccountRouting(a, bad, 1)).toThrow(RoutingOrderError);
    }
    expect(() => saveAccountRouting(a, [{ key: DEFAULT_ENTRY }, { key: DEFAULT_ENTRY }], 1)).toThrow(/duplicate/);
    expect(getAccountRouting(a).map((e) => e.key)).toEqual([DEFAULT_ENTRY]); // nothing changed
    deleteProvider(shared, a);
  });

  it('removing a provider removes its entry; a stale saved row never resurrects it', () => {
    const a = createAccount({ name: 'Order E' }).id;
    const p1 = own(a, 'one');
    deleteProvider(p1, a);
    expect(getAccountRouting(a).map((e) => e.key)).toEqual([DEFAULT_ENTRY]);
    getDb().prepare("INSERT OR REPLACE INTO ai_account_routing (whatsapp_account_id, entry_key, position) VALUES (?, 'provider:999999', 2)").run(a);
    expect(getAccountRouting(a).map((e) => e.key)).toEqual([DEFAULT_ENTRY]);
  });

  it('migration 029 gives existing businesses Default first, then their own providers by their old priority', () => {
    const a = createAccount({ name: 'Order F' }).id;
    const late = own(a, 'late', 30);
    const early = own(a, 'early', 10);
    getDb().prepare('DELETE FROM ai_account_routing WHERE whatsapp_account_id = ?').run(a); // as on a database from before the feature
    const sql = fs.readFileSync(path.join(__dirname, '../../../src/memory/migrations/029_ai_account_routing.sql'), 'utf8');
    getDb().exec(sql);
    expect(getAccountRouting(a).map((e) => e.key)).toEqual([DEFAULT_ENTRY, providerEntryKey(early), providerEntryKey(late)]);
    expect((getDb().prepare('SELECT entry_key FROM ai_account_routing WHERE whatsapp_account_id = ? ORDER BY position').all(a) as Array<{ entry_key: string }>).map((r) => r.entry_key)).toEqual([DEFAULT_ENTRY, providerEntryKey(early), providerEntryKey(late)]);
  });
});

describe('the two-field provider form', () => {
  it('recognises the provider from the key prefix and fills endpoint, kind and models; an unknown key needs the provider named', () => {
    expect(detectPresetId('gsk_abcdefghijklmnopqrstuvwxyz0123456789')).toBe('groq');
    expect(detectPresetId('AIzaSyabcdefghijklmnopqrstuvwxyz0123456')).toBe('google');
    expect(detectPresetId('sk-or-v1-abcdefghijklmnopqrstuvwxyz012345')).toBe('openrouter');
    expect(detectPresetId('csk-abcdefghijklmnopqrstuvwxyz0123456789')).toBe('cerebras');
    expect(detectPresetId('whatever-key-value-123456789012345678901')).toBeNull();
    const groq = resolveSimpleProvider({ name: 'G', config: 'gsk_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(groq).toMatchObject({ kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', freeTier: true, apiKey: 'gsk_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(groq.models.length).toBeGreaterThan(0);
    expect(() => resolveSimpleProvider({ name: 'M', config: 'whatever-key-value-123456789012345678901' })).toThrow(SimpleProviderError);
    expect(resolveSimpleProvider({ name: 'M', config: 'whatever-key-value-123456789012345678901', provider: 'mistral' })).toMatchObject({ baseUrl: 'https://api.mistral.ai/v1' });
  });

  it('a URL is never accepted as the configuration (the endpoint comes from the preset or "More options"), and no local runtime preset exists', () => {
    expect(() => resolveSimpleProvider({ name: 'X', config: 'https://api.example.com/v1', provider: 'groq' })).toThrow(SimpleProviderError);
    expect(() => resolveSimpleProvider({ name: 'X', config: 'http://127.0.0.1:11434', provider: 'ollama' })).toThrow(SimpleProviderError);
    expect(resolveSimpleProvider({ name: 'G', config: 'gsk_abcdefghijklmnopqrstuvwxyz0123456789' }).enabled).toBe(true);
  });
});
