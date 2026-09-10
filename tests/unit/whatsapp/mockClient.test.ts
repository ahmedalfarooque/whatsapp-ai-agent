import { describe, it, expect } from 'vitest';
import { sendTextMessageMock, markMessageAsReadMock } from '../../../src/whatsapp/mockClient';

describe('WhatsApp mock provider', () => {
  it('returns a deterministic, well-shaped response without any network call', async () => {
    const result = await sendTextMessageMock('15551234567', 'hello');
    expect(result.messaging_product).toBe('whatsapp');
    expect(result.contacts[0].wa_id).toBe('15551234567');
    expect(result.messages[0].id).toMatch(/^mock-wamid-/);
  });

  it('markMessageAsReadMock resolves without throwing and without a network call', async () => {
    await expect(markMessageAsReadMock('wamid.123')).resolves.toBeUndefined();
  });
});
