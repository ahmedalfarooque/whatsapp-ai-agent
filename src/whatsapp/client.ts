import { env } from '../config/env';
import { logger } from '../logger';
import { fetchWithTimeout, withRetry, HttpError, isRetryableHttpError } from '../utils/retry';
import type { SendTextMessageResponse } from './types';

function graphUrl(pathSegment: string): string {
  return `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${pathSegment}`;
}

async function graphRequest<T>(pathSegment: string, body: Record<string, unknown>): Promise<T> {
  return withRetry(
    async () => {
      const response = await fetchWithTimeout(
        graphUrl(pathSegment),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
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
      isRetryable: isRetryableHttpError,
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
  try {
    const result = await graphRequest<SendTextMessageResponse>(
      `${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: toWaId,
        type: 'text',
        text: { preview_url: false, body },
      },
    );
    logger.info({ toWaId, messageId: result.messages?.[0]?.id }, 'sent WhatsApp text message');
    return result;
  } catch (error) {
    logger.error({ toWaId, error }, 'failed to send WhatsApp text message');
    throw error;
  }
}

/** Marks an inbound message as read (best-effort, failures are logged not thrown). */
export async function markMessageAsRead(messageId: string): Promise<void> {
  try {
    await graphRequest(`${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  } catch (error) {
    logger.warn({ messageId, error }, 'failed to mark WhatsApp message as read (non-fatal)');
  }
}
