import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { getEffectiveCredential } from '../config/effectiveConfig';
import { logger } from '../logger';

/** Attaches the raw request body buffer so the HMAC can be computed over exact bytes. */
export function rawBodySaver(req: Request, _res: Response, buf: Buffer): void {
  (req as Request & { rawBody?: Buffer }).rawBody = buf;
}

function computeSignature(rawBody: Buffer): string {
  const secret = getEffectiveCredential('META_APP_SECRET');
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/**
 * Validates Meta's X-Hub-Signature-256 header against an HMAC-SHA256 of the
 * raw request body, using the app secret. Rejects with 401 on mismatch or
 * missing signature/body — never trusts an unsigned or tampered payload.
 */
export function verifySignatureMiddleware(req: Request, res: Response, next: NextFunction): void {
  const signatureHeader = req.header('x-hub-signature-256');
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

  if (!signatureHeader || !rawBody) {
    logger.warn('rejected webhook request: missing signature header or body');
    res.status(401).json({ error: 'missing signature' });
    return;
  }

  const expected = computeSignature(rawBody);
  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(signatureHeader);

  const isValid =
    expectedBuf.length === receivedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, receivedBuf);

  if (!isValid) {
    logger.warn('rejected webhook request: invalid signature');
    res.status(401).json({ error: 'invalid signature' });
    return;
  }

  next();
}
