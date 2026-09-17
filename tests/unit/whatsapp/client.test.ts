import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// This file tests the REAL Graph API request path — same override as
// tests/unit/calendar/booking.test.ts, see that file for why.
vi.mock('../../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../../src/config/env')>(
    '../../../src/config/env',
  );
  return { ...actual, env: { ...actual.env, shouldUseMockProviders: false } };
});

import { sendTextMessage, markMessageAsRead, sendInteractiveMessage } from '../../../src/whatsapp/client';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('WhatsApp client — HTTP behavior', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends a text message successfully on the first try', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'wamid.1' }] }),
    );

    const result = await sendTextMessage('15551234567', 'hello');

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(result.messages[0].id).toBe('wamid.1');
  });

  it('does NOT retry a 4xx (permanent) error — surfaces it immediately', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(401, { error: { message: 'Invalid OAuth access token' } }));

    await expect(sendTextMessage('15551234567', 'hi')).rejects.toThrow(/401/);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('retries a 429 (rate limit) and eventually succeeds', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: 'rate limited' } }))
      .mockResolvedValueOnce(jsonResponse(200, { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'wamid.2' }] }));

    const result = await sendTextMessage('15551234567', 'hi');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.messages[0].id).toBe('wamid.2');
  });

  it('retries a 5xx and eventually succeeds', async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(503, { error: { message: 'temporarily unavailable' } }))
      .mockResolvedValueOnce(jsonResponse(200, { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'wamid.3' }] }));

    const result = await sendTextMessage('15551234567', 'hi');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.messages[0].id).toBe('wamid.3');
  });

  it(
    'does NOT retry a timeout/network error when sending a message — a duplicate send would be a real ' +
      'customer-visible duplicate message',
    async () => {
      fetchSpy.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

      await expect(sendTextMessage('15551234567', 'hi')).rejects.toThrow();
      expect(fetchSpy).toHaveBeenCalledOnce(); // not retried
    },
  );

  it('markMessageAsRead is best-effort: a failure is swallowed, never thrown to the caller', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(500, { error: { message: 'down' } }));

    await expect(markMessageAsRead('wamid.1')).resolves.toBeUndefined();
  });

  it('sends a button interactive message with the expected Graph API shape', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'wamid.4' }] }),
    );

    await sendInteractiveMessage('15551234567', {
      kind: 'buttons',
      body: 'Pick one',
      buttons: [{ id: 'a', title: 'A' }],
    });

    const [, requestInit] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body as string);
    expect(sentBody.type).toBe('interactive');
    expect(sentBody.interactive.type).toBe('button');
    expect(sentBody.interactive.action.buttons).toEqual([{ type: 'reply', reply: { id: 'a', title: 'A' } }]);
  });

  it('sends a list interactive message with the expected Graph API shape', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'wamid.5' }] }),
    );

    await sendInteractiveMessage('15551234567', {
      kind: 'list',
      body: 'Choose',
      buttonLabel: 'Show options',
      sections: [{ rows: [{ id: 'x', title: 'X' }] }],
    });

    const [, requestInit] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body as string);
    expect(sentBody.interactive.type).toBe('list');
    expect(sentBody.interactive.action.button).toBe('Show options');
    expect(sentBody.interactive.action.sections).toEqual([{ rows: [{ id: 'x', title: 'X' }] }]);
  });

  it('never logs the access token in a thrown/rejected error', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(401, { error: { message: 'bad token' } }));

    let caught: unknown;
    try {
      await sendTextMessage('15551234567', 'hi');
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain('Bearer');
  });
});
