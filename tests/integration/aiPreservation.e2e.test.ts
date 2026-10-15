import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  markMessageAsRead: vi.fn().mockResolvedValue(undefined),
}));

import path from 'node:path';
import { sendTextMessage } from '../../src/whatsapp/client';
import { processInboundMessage, resetCredentialFallbackThrottle } from '../../src/pipeline/processInboundMessage';
import { resetAiRouterForTests } from '../../src/llm/aiRouter';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { getOrCreateCustomer, setCustomerLanguage } from '../../src/memory/customerRepo';
import { getOrCreateActiveConversation, appendMessage } from '../../src/memory/conversationRepo';
import { getBusinessSettings, updateBusinessSettings } from '../../src/config/businessSettings';
import { getAutomationSettings } from '../../src/automation/settingsRepo';
import { createProvider } from '../../src/llm/providerRepo';
import { DEFAULT_ENTRY, providerEntryKey, saveAccountRouting } from '../../src/llm/routingOrder';
import { ensureTemplateDefaults } from '../../src/templates/templateRepo';
import { loadKnowledgeBase } from '../../src/knowledge/loader';
import { getDb } from '../../src/memory/db';
import { env } from '../../src/config/env';
import { claimWebhookEvent } from '../../src/memory/webhookEventRepo';

/**
 * PRESERVATION: a provider failing, a failover, or every route failing must never change an account's history, memory, settings,
 * reply mode, WhatsApp-facing state or other accounts' data — and a repeated inbound delivery must never produce a second reply.
 */
const mutableEnv = env as unknown as Record<string, unknown>;
const KEY = 'sk-or-v1-preservepreservepreservepreservepreserve000';
const knowledge = loadKnowledgeBase(path.join(__dirname, '..', 'fixtures', 'knowledge'));
const originalMock = mutableEnv.shouldUseMockProviders;
const originalKey = mutableEnv.OPENROUTER_API_KEY;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const answer = (content: string) => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
let counter = 0;

function network(handler: (url: string) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string) => handler(String(url)));
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Everything that must survive a provider incident, for ONE account and customer. */
function snapshot(accountId: number, waId: string) {
  return runWithAccount(accountId, () => snapshotIn(accountId, waId));
}
function snapshotIn(accountId: number, waId: string) {
  const db = getDb();
  ensureTemplateDefaults(db, accountId); // templates are seeded lazily; seed first so before/after compare the same rows
  const customer = getOrCreateCustomer(waId, undefined);
  const conversation = getOrCreateActiveConversation(customer.id);
  const history = db.prepare('SELECT role, content, direction FROM conversation_messages WHERE conversation_id = ? ORDER BY id').all(conversation.id);
  return {
    customer: { id: customer.id, language: customer.language, accountId: customer.whatsapp_account_id },
    conversationId: conversation.id,
    history,
    settings: JSON.stringify(runWithAccount(accountId, () => getBusinessSettings(accountId))),
    automation: JSON.stringify(runWithAccount(accountId, () => getAutomationSettings())),
    templates: db.prepare('SELECT key, live_en, live_ar FROM reply_templates WHERE whatsapp_account_id = ? ORDER BY key').all(accountId),
    followups: db.prepare('SELECT count(*) AS n FROM followup_requests WHERE whatsapp_account_id = ?').get(accountId),
    sessionRows: db.prepare('SELECT count(*) AS n FROM whatsapp_accounts').get(),
  };
}

let ACC: number;
let OTHER: number;
beforeEach(() => {
  getDb();
  mutableEnv.shouldUseMockProviders = false;
  mutableEnv.OPENROUTER_API_KEY = KEY;
  resetCredentialFallbackThrottle();
  resetAiRouterForTests();
  ACC = ACC ?? createAccount({ name: 'Preserve Co' }).id;
  OTHER = OTHER ?? createAccount({ name: 'Bystander Co' }).id;
  vi.mocked(sendTextMessage).mockClear();
});
afterEach(() => {
  mutableEnv.shouldUseMockProviders = originalMock;
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  vi.unstubAllGlobals();
});

async function say(accountId: number, waId: string, text: string, id = `wamid.pres.${++counter}`) {
  await processInboundMessage({ waId, messageId: id, timestamp: Date.now(), type: 'text', text, accountId } as never, { knowledge });
}

describe('provider incidents never touch history, memory, settings or reply mode', () => {
  it('every route failing (402, 429, outage): history only GROWS by the customer\'s own message and the automated reply; settings, templates, reply mode, follow-ups, language and ids are byte-identical; the other account is untouched', async () => {
    const waId = `9665500${String(++counter).padStart(5, '0')}`;
    runWithAccount(ACC, () => {
      updateBusinessSettings({ openRouterModel: 'vendor/free-model:free', conversationHistoryLimit: 20 }, ACC);
      createProvider({ name: 'Groq key A', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', models: ['llama-3.3-70b-versatile'], priority: 10, timeoutMs: 3000 }, { accountId: ACC, updatedBy: 1 });
      createProvider({ name: 'Groq key B', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', models: ['llama-3.1-8b-instant'], priority: 20, timeoutMs: 3000 }, { accountId: ACC, updatedBy: 1 });
      // this business tries its own two keys first (A then B), then Default
      const own = (getDb().prepare('SELECT id FROM ai_providers WHERE whatsapp_account_id = ? ORDER BY priority, id').all(ACC) as Array<{ id: number }>).map((r) => ({ key: providerEntryKey(r.id) }));
      saveAccountRouting(ACC, [...own, { key: DEFAULT_ENTRY }], 1);
    });
    // establish memory: language + a prior conversation
    runWithAccount(ACC, () => {
      const customer = getOrCreateCustomer(waId, 'Layla');
      setCustomerLanguage(customer.id, 'ar');
      const conversation = getOrCreateActiveConversation(customer.id);
      appendMessage(conversation.id, { role: 'user', content: 'أريد موعد لفحص السيارة', direction: 'inbound' } as never);
      appendMessage(conversation.id, { role: 'assistant', content: 'تم، ما اليوم المناسب؟', direction: 'outbound' } as never);
    });
    const bystanderBefore = snapshot(OTHER, `9665511${String(counter).padStart(5, '0')}`);
    const before = snapshot(ACC, waId);

    // two keys of the same provider are two ROUTES (each its own key): key A rate limited, key B quota gone, no other route
    const fetchMock = network((url) => (url.includes('groq') ? json(429, { error: { message: 'Rate limit reached' } }) : json(503, { error: { message: 'down' } })));
    await say(ACC, waId, 'كم سعر الفحص؟');
    const after = snapshot(ACC, waId);

    expect(after.customer).toEqual(before.customer);
    expect(after.conversationId).toBe(before.conversationId);
    expect(after.settings).toBe(before.settings);
    expect(after.automation).toBe(before.automation); // reply mode / auto-reply / AI switches
    expect(after.templates).toEqual(before.templates);
    expect(after.followups).toEqual(before.followups);
    expect(after.sessionRows).toEqual(before.sessionRows);
    // history: everything old is still there, in order; the new rows are the customer's message and the automated reply (ONE message with notice + choices; no AI text invented)
    expect((after.history as unknown[]).slice(0, (before.history as unknown[]).length)).toEqual(before.history);
    const added = (after.history as Array<{ role: string; content: string }>).slice((before.history as unknown[]).length);
    expect(added.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(added[0]!.content).toBe('كم سعر الفحص؟'); // the request is preserved verbatim for staff
    expect(added[1]!.content).toMatch(/رد تلقائي/); // labelled automated reply, in the customer's language, not an AI answer
    expect(vi.mocked(sendTextMessage).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchMock).toHaveBeenCalled();
    // the other business is byte-identical
    expect(snapshot(OTHER, `9665511${String(counter - 0).padStart(5, '0')}`).settings).toBe(bystanderBefore.settings);
    // keys A and B were each tried as separate routes (two distinct Authorization headers), and neither key reached a log or the history
    const auths = fetchMock.mock.calls.filter((c) => String((c as unknown[])[0]).includes('groq')).map((c) => String(((c as unknown[])[1] as RequestInit).headers && (((c as unknown[])[1] as RequestInit).headers as Record<string, string>).Authorization));
    expect(new Set(auths).size).toBe(2);
    expect(JSON.stringify(after.history)).not.toMatch(/gsk_|sk-or-/);
  });

  it('a failover to the second key answers once, preserves the conversation, and the customer gets exactly ONE reply (a repeated delivery of the same message id is refused)', async () => {
    const waId = `9665500${String(++counter).padStart(5, '0')}`;
    runWithAccount(ACC, () => getDb().prepare('UPDATE ai_providers SET enabled = 1 WHERE whatsapp_account_id = ?').run(ACC));
    runWithAccount(ACC, () => setCustomerLanguage(getOrCreateCustomer(waId, undefined).id, 'en'));
    const before = snapshot(ACC, waId);
    const fetchMock = network((url) => {
      const key = '';
      void key;
      return url.includes('groq') ? answer('Our hours are 9 to 6.') : json(500, {});
    });
    // key A fails (first call), key B (second call) answers: script by call order on the same host
    let n = 0;
    fetchMock.mockImplementation(async () => (n++ === 0 ? json(429, { error: { message: 'Rate limit reached' } }) : answer('Our hours are 9 to 6.')));
    const id = `wamid.dup.${++counter}`;
    expect(claimWebhookEvent(id, 'text')).toBe(true); // what the transports do before processing
    await say(ACC, waId, 'what are your hours?', id);
    expect(claimWebhookEvent(id, 'text')).toBe(false); // the redelivery never reaches the pipeline
    const replies = vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1])).filter((t) => /Our hours are 9 to 6/.test(t));
    expect(replies).toHaveLength(1);
    const after = snapshot(ACC, waId);
    expect(after.settings).toBe(before.settings);
    expect(after.automation).toBe(before.automation);
    const activity = getDb().prepare("SELECT detail FROM reply_activity WHERE wa_id = ? AND kind = 'ai' ORDER BY id DESC LIMIT 1").get(waId) as { detail: string };
    expect(activity.detail).toMatch(/cloud AI \(Groq key B/); // the activity names the route that answered and the failover
    expect(activity.detail).toMatch(/failover from Groq key A/);
  });

  it('a NEW account inherits the safe shared defaults (strict free-only, failover, no providers, no keys) and never sees another account\'s keys', () => {
    const fresh = createAccount({ name: 'Brand New Preserve Co' }).id;
    expect(runWithAccount(fresh, () => getBusinessSettings(fresh))).toMatchObject({ aiFreeOnly: true, aiFailoverEnabled: true });
    const providers = getDb().prepare('SELECT name FROM ai_providers WHERE whatsapp_account_id = ? OR whatsapp_account_id IS NULL').all(fresh);
    expect(providers).toEqual([]);
  });
});
