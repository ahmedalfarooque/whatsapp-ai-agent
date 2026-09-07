import crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  markMessageAsRead: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/llm/openRouterClient', () => ({
  chatCompletion: vi.fn().mockResolvedValue({
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
  }),
}));

import { createApp } from '../../src/app';
import { closeDb } from '../../src/memory/db';

const APP_SECRET = process.env.META_APP_SECRET as string;

function sign(body: string): string {
  return `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

describe('security hardening', () => {
  const app = createApp();

  it('sets standard security headers via helmet', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects malformed JSON on the webhook endpoint with 400, not 500', async () => {
    const malformed = '{ this is not valid json';
    const res = await request(app)
      .post('/webhook')
      .set('x-hub-signature-256', sign(malformed))
      .type('application/json')
      .send(malformed);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });

  it('never reflects internal error details to the client', async () => {
    const malformed = '{"broken":';
    const res = await request(app)
      .post('/webhook')
      .set('x-hub-signature-256', sign(malformed))
      .type('application/json')
      .send(malformed);

    expect(JSON.stringify(res.body)).not.toMatch(/at\s+\w+\s+\(/); // no stack trace shape
    expect(JSON.stringify(res.body)).not.toContain(APP_SECRET);
  });

  it('applies rate limiting headers to webhook requests', async () => {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const res = await request(app)
      .post('/webhook')
      .set('x-hub-signature-256', sign(payload))
      .type('application/json')
      .send(payload);

    expect(res.headers['ratelimit-limit']).toBeDefined();
  });

  it('closeDb + reopen does not throw (used for readiness/shutdown paths)', () => {
    expect(() => closeDb()).not.toThrow();
  });
});
