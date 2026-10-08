import pino from 'pino';
import { env } from './config/env';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-hub-signature-256"]',
  // The dashboard session token travels in these headers; request logging serialises them verbatim, so a
  // successful sign-in would otherwise write a live session token into the service log.
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.accessToken',
  '*.access_token',
  '*.apiKey',
  '*.api_key',
  '*.privateKey',
  '*.private_key',
  '*.password',
  '*.token',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  base: { service: 'whatsapp-ai-agent' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Masks all but the last 4 digits of a WhatsApp number for log-safe display. */
export function maskWaId(waId: string | undefined | null): string {
  if (!waId) return 'unknown';
  const digits = waId.replace(/\D/g, '');
  if (digits.length <= 4) return '*'.repeat(digits.length);
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}

export type Logger = typeof logger;
