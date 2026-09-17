import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  markMessageAsRead: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/llm/openRouterClient', () => ({
  chatCompletion: vi.fn().mockResolvedValue({
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hi there!' } }],
  }),
}));

import { sendTextMessage } from '../../src/whatsapp/client';
import { createApp } from '../../src/app';
import { closeDb } from '../../src/memory/db';
import { getOrCreateCustomer, setCustomerLanguage } from '../../src/memory/customerRepo';

/** These tests exercise the AI reply path directly, so pre-select a language to skip the menu gate. */
function preselectLanguage(waId: string) {
  const customer = getOrCreateCustomer(waId, undefined);
  setCustomerLanguage(customer.id, 'en');
}

const APP_SECRET = process.env.META_APP_SECRET as string;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN as string;

function sign(body: string): string {
  return `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function inboundTextPayload(waId: string, messageId: string, text: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              contacts: [{ profile: { name: 'Alice' }, wa_id: waId }],
              messages: [
                { from: waId, id: messageId, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('webhook integration', () => {
  const app = createApp();

  beforeEach(() => {
    vi.mocked(sendTextMessage).mockClear();
  });

  afterEach(() => {
    closeDb();
  });

  it('handles the GET verification handshake', async () => {
    const res = await request(app)
      .get('/webhook')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'abc123' });

    expect(res.status).toBe(200);
    expect(res.text).toBe('abc123');
  });

  it('rejects an unsigned POST request', async () => {
    const res = await request(app).post('/webhook').send(inboundTextPayload('15551110000', 'wamid.1', 'hi'));
    expect(res.status).toBe(401);
  });

  it('acknowledges a validly signed POST request immediately with 200', async () => {
    const payload = inboundTextPayload('15551110001', 'wamid.2', 'Hi, what are your hours?');
    const body = JSON.stringify(payload);

    const res = await request(app)
      .post('/webhook')
      .set('x-hub-signature-256', sign(body))
      .type('application/json')
      .send(body);

    expect(res.status).toBe(200);
  });

  it('eventually sends a WhatsApp reply after async processing completes', async () => {
    preselectLanguage('15551110002');
    const payload = inboundTextPayload('15551110002', 'wamid.3', 'Hi, what are your hours?');
    const body = JSON.stringify(payload);

    await request(app)
      .post('/webhook')
      .set('x-hub-signature-256', sign(body))
      .type('application/json')
      .send(body);

    await waitUntil(() => vi.mocked(sendTextMessage).mock.calls.length > 0);
    expect(sendTextMessage).toHaveBeenCalledWith('15551110002', 'Hi there!');
  });

  it('processes a duplicate webhook delivery (same message id) only once', async () => {
    preselectLanguage('15551110003');
    const payload = inboundTextPayload('15551110003', 'wamid.DUPLICATE', 'Hello');
    const body = JSON.stringify(payload);
    const signature = sign(body);

    await request(app).post('/webhook').set('x-hub-signature-256', signature).type('application/json').send(body);
    await waitUntil(() => vi.mocked(sendTextMessage).mock.calls.length > 0);

    const callsAfterFirst = vi.mocked(sendTextMessage).mock.calls.length;

    // Meta redelivers the identical event (network retry) — must be a no-op.
    await request(app).post('/webhook').set('x-hub-signature-256', signature).type('application/json').send(body);
    await new Promise((r) => setTimeout(r, 100));

    expect(vi.mocked(sendTextMessage).mock.calls.length).toBe(callsAfterFirst);
  });
});
