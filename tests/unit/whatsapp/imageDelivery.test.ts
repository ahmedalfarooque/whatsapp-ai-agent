import { describe, expect, it, vi } from 'vitest';
import { replyTransport, type ReplyTransport } from '../../../src/whatsapp/replyTransport';
import { sendImageMessage, ImageDeliveryUnsupportedError } from '../../../src/whatsapp/client';
import { env } from '../../../src/config/env';

const picture = { fileName: 'a.png', mimeType: 'image/png', bytes: Buffer.from('png'), caption: 'Deal' };
const ok = { messaging_product: 'whatsapp' as const, contacts: [], messages: [{ id: 'x' }] };

describe('sendImageMessage uses the connection the message arrived on', () => {
  it('goes through the transport\'s image method when it has one (the QR / Baileys connection)', async () => {
    const image = vi.fn().mockResolvedValue(ok);
    const transport = { text: vi.fn(), interactive: vi.fn(), image } as unknown as ReplyTransport;
    await replyTransport.run(transport, () => sendImageMessage('966500000001', picture));
    expect(image).toHaveBeenCalledWith('966500000001', picture);
  });

  it('refuses, rather than faking it with a link, on a connection that cannot carry images (the Meta Cloud API one)', async () => {
    const transport = { text: vi.fn(), interactive: vi.fn() } as unknown as ReplyTransport;
    await expect(replyTransport.run(transport, () => sendImageMessage('966500000001', picture))).rejects.toBeInstanceOf(ImageDeliveryUnsupportedError);
    expect(transport.text).not.toHaveBeenCalled();
  });

  it('in development (mock providers, no connection) it only logs and never touches the network', async () => {
    expect(env.shouldUseMockProviders).toBe(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(sendImageMessage('966500000001', picture)).resolves.toMatchObject({ messaging_product: 'whatsapp' });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
