import { env } from '../config/env';
import { logger } from '../logger';
import { fetchWithTimeout } from '../utils/retry';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export class EmailSendError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'EmailSendError';
  }
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 15_000;

/** True when a Resend API key and sender address are configured (env only — never from the browser). */
export function resendConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL);
}

/**
 * Sends one transactional email through Resend's REST API. The API key is
 * read from the environment at call time and only ever placed in the
 * Authorization header; it is never logged, returned or stored. Message
 * bodies are never logged either — callers put one-time codes in them.
 */
export async function sendResendEmail(message: OutboundEmail): Promise<{ id: string | null }> {
  if (!resendConfigured()) throw new EmailSendError('email delivery is not configured');
  let response: Response;
  try {
    response = await fetchWithTimeout(
      RESEND_ENDPOINT,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
      },
      SEND_TIMEOUT_MS,
    );
  } catch (error) {
    logger.warn({ error: (error as Error).name }, 'email: Resend request failed (network/timeout)');
    throw new EmailSendError('email provider unreachable');
  }
  if (!response.ok) {
    // Resend's error body names the failing field (e.g. an unverified sender domain) but never echoes the key.
    let detail = '';
    try { detail = String(((await response.json()) as { message?: string }).message ?? '').slice(0, 200); } catch { /* ignore */ }
    logger.warn({ status: response.status, detail }, 'email: Resend rejected the message');
    throw new EmailSendError(`email provider responded with HTTP ${response.status}`, response.status);
  }
  let id: string | null = null;
  try { id = String(((await response.json()) as { id?: string }).id ?? '') || null; } catch { /* ignore */ }
  logger.info({ id }, 'email: sent via Resend');
  return { id };
}
