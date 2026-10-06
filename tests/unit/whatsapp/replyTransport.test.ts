import { describe, it, expect, vi } from 'vitest';
import { replyTransport, type ReplyTransport } from '../../../src/whatsapp/replyTransport';
import { sendTextMessage, sendInteractiveMessage } from '../../../src/whatsapp/client';

describe('request-scoped reply routing', () => {
  it('keeps simultaneous linked-device and normal replies isolated', async () => {
    const response = { messaging_product: 'whatsapp' as const, contacts: [], messages: [{ id: 'QR' }] };
    const transport: ReplyTransport = { text: vi.fn().mockResolvedValue(response), interactive: vi.fn().mockResolvedValue(response) };
    const [qr, normal] = await Promise.all([
      replyTransport.run(transport, async () => { await Promise.resolve(); return sendTextMessage('123@c.us', 'QR reply'); }),
      sendTextMessage('456', 'Normal reply'),
    ]);
    expect(qr.messages[0]?.id).toBe('QR');
    expect(normal.messages[0]?.id).toMatch(/^mock-/);
    expect(transport.text).toHaveBeenCalledTimes(1);
    expect(transport.text).toHaveBeenCalledWith('123@c.us', 'QR reply');
    expect(replyTransport.getStore()).toBeUndefined();
  });
  it('sends menu replies through the same linked-device transport', async () => {
    const transport: ReplyTransport = { text: vi.fn(), interactive: vi.fn().mockResolvedValue({ messages: [{ id: 'menu' }] }) };
    const menu = { kind: 'buttons' as const, body: 'Choose', buttons: [{ id: 'en', title: 'English' }] };
    await replyTransport.run(transport, () => sendInteractiveMessage('123@c.us', menu));
    expect(transport.interactive).toHaveBeenCalledWith('123@c.us', menu);
  });
});
