import { logger } from '../logger';
import type { OutboundInteractiveMessage, SendTextMessageResponse } from './types';

/**
 * Mock WhatsApp Cloud API provider used whenever env.shouldUseMockProviders
 * is true (i.e. NODE_ENV !== 'production'). Never makes a network call —
 * safe to run with no WhatsApp credentials configured at all.
 */
export async function sendTextMessageMock(
  toWaId: string,
  body: string,
): Promise<SendTextMessageResponse> {
  logger.info(
    { toWaId, body },
    '[MOCK WhatsApp] would send this message — development mode, no real message sent',
  );
  return {
    messaging_product: 'whatsapp',
    contacts: [{ input: toWaId, wa_id: toWaId }],
    messages: [{ id: `mock-wamid-${Date.now()}` }],
  };
}

export async function sendInteractiveMessageMock(
  toWaId: string,
  message: OutboundInteractiveMessage,
): Promise<SendTextMessageResponse> {
  logger.info(
    { toWaId, message },
    '[MOCK WhatsApp] would send this interactive message — development mode, no real message sent',
  );
  return {
    messaging_product: 'whatsapp',
    contacts: [{ input: toWaId, wa_id: toWaId }],
    messages: [{ id: `mock-wamid-${Date.now()}` }],
  };
}

export async function markMessageAsReadMock(messageId: string): Promise<void> {
  logger.info(
    { messageId },
    '[MOCK WhatsApp] would mark message as read — development mode, no real API call',
  );
}
