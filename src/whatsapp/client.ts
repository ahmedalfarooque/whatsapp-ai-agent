import { env } from '../config/env';
import { replyTransport } from './replyTransport';
import { getEffectiveCredential } from '../config/effectiveConfig';
import { logger } from '../logger';
import {
  fetchWithTimeout,
  withRetry,
  HttpError,
  isRetryableHttpError,
  isRetryableForNonIdempotentSend,
} from '../utils/retry';
import { sendTextMessageMock, markMessageAsReadMock, sendInteractiveMessageMock, sendDocumentMessageMock } from './mockClient';
import type { OutboundDocument, OutboundInteractiveMessage, SendTextMessageResponse } from './types';

function graphUrl(pathSegment: string): string {
  return `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${pathSegment}`;
}

async function graphRequest<T>(
  pathSegment: string,
  body: Record<string, unknown>,
  isRetryable: (error: unknown) => boolean,
): Promise<T> {
  return withRetry(
    async () => {
      const response = await fetchWithTimeout(
        graphUrl(pathSegment),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${getEffectiveCredential('WHATSAPP_ACCESS_TOKEN')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        env.WHATSAPP_TIMEOUT_MS,
      );

      if (!response.ok) {
        const errorBody = await response.text().catch(() => undefined);
        throw new HttpError(`WhatsApp Graph API error: ${response.status}`, response.status, errorBody);
      }

      return (await response.json()) as T;
    },
    {
      retries: 2,
      isRetryable,
      onRetry: (error, attempt) => {
        logger.warn({ error, attempt }, 'retrying WhatsApp Graph API request');
      },
    },
  );
}

/** Sends a plain text message to a customer's WhatsApp number via the Cloud API. */
export async function sendTextMessage(
  toWaId: string,
  body: string,
): Promise<SendTextMessageResponse> {
  const transport = replyTransport.getStore();
  if (transport) return transport.text(toWaId, body);
  if (env.shouldUseMockProviders) {
    return sendTextMessageMock(toWaId, body);
  }
  try {
    // Sending a message is NOT idempotent — a duplicate send is a real,
    // customer-visible message the customer would receive twice. Only
    // retry on a definite server-side rejection (429/5xx); never retry on
    // an ambiguous network/timeout error, since the message may have
    // already been delivered before we gave up waiting for the response.
    const result = await graphRequest<SendTextMessageResponse>(
      `${getEffectiveCredential('WHATSAPP_PHONE_NUMBER_ID')}/messages`,
      {
        messaging_product: 'whatsapp',
        to: toWaId,
        type: 'text',
        text: { preview_url: false, body },
      },
      isRetryableForNonIdempotentSend,
    );
    logger.info({ toWaId, messageId: result.messages?.[0]?.id }, 'sent WhatsApp text message');
    return result;
  } catch (error) {
    logger.error({ toWaId, error }, 'failed to send WhatsApp text message');
    throw error;
  }
}

function buildInteractivePayload(message: OutboundInteractiveMessage): Record<string, unknown> {
  if (message.kind === 'buttons') {
    return {
      type: 'button',
      ...(message.header ? { header: { type: 'text', text: message.header } } : {}),
      body: { text: message.body },
      ...(message.footer ? { footer: { text: message.footer } } : {}),
      action: {
        buttons: message.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    };
  }
  return {
    type: 'list',
    ...(message.header ? { header: { type: 'text', text: message.header } } : {}),
    body: { text: message.body },
    ...(message.footer ? { footer: { text: message.footer } } : {}),
    action: {
      button: message.buttonLabel,
      sections: message.sections.map((s) => ({
        ...(s.title ? { title: s.title } : {}),
        rows: s.rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) })),
      })),
    },
  };
}

export class DocumentDeliveryUnsupportedError extends Error {
  constructor() {
    super('This WhatsApp connection cannot send documents');
    this.name = 'DocumentDeliveryUnsupportedError';
  }
}

/**
 * Sends a file (a catalogue PDF) through the SAME transport the inbound message arrived on. Only the QR (Baileys)
 * connection delivers documents; there is no second transport and no fake URL fallback.
 */
export async function sendDocumentMessage(toWaId: string, document: OutboundDocument): Promise<SendTextMessageResponse> {
  const transport = replyTransport.getStore();
  if (transport?.document) return transport.document(toWaId, document);
  if (env.shouldUseMockProviders && !transport) return sendDocumentMessageMock(toWaId, document);
  throw new DocumentDeliveryUnsupportedError();
}

/** Sends an interactive (button or list) message to a customer's WhatsApp number. */
export async function sendInteractiveMessage(
  toWaId: string,
  message: OutboundInteractiveMessage,
): Promise<SendTextMessageResponse> {
  const transport = replyTransport.getStore();
  if (transport) return transport.interactive(toWaId, message);
  if (env.shouldUseMockProviders) {
    return sendInteractiveMessageMock(toWaId, message);
  }
  try {
    const result = await graphRequest<SendTextMessageResponse>(
      `${getEffectiveCredential('WHATSAPP_PHONE_NUMBER_ID')}/messages`,
      {
        messaging_product: 'whatsapp',
        to: toWaId,
        type: 'interactive',
        interactive: buildInteractivePayload(message),
      },
      isRetryableForNonIdempotentSend,
    );
    logger.info({ toWaId, messageId: result.messages?.[0]?.id }, 'sent WhatsApp interactive message');
    return result;
  } catch (error) {
    logger.error({ toWaId, error }, 'failed to send WhatsApp interactive message');
    throw error;
  }
}

/** Marks an inbound message as read (best-effort, failures are logged not thrown). */
export async function markMessageAsRead(messageId: string): Promise<void> {
  if (env.shouldUseMockProviders) {
    return markMessageAsReadMock(messageId);
  }
  try {
    // Marking a message read is idempotent from the customer's perspective
    // (no visible duplicate effect), so the generic retry policy is fine here.
    await graphRequest(
      `${getEffectiveCredential('WHATSAPP_PHONE_NUMBER_ID')}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      },
      isRetryableHttpError,
    );
  } catch (error) {
    logger.warn({ messageId, error }, 'failed to mark WhatsApp message as read (non-fatal)');
  }
}
