import type { Request, Response } from 'express';
import { getEffectiveCredential } from '../config/effectiveConfig';
import { logger } from '../logger';

/** Handles Meta's GET /webhook verification handshake (setup + resubscribe). */
export function handleWebhookVerification(req: Request, res: Response): void {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === getEffectiveCredential('WHATSAPP_VERIFY_TOKEN')) {
    logger.info('webhook verification succeeded');
    res.status(200).send(challenge);
    return;
  }

  logger.warn({ mode }, 'webhook verification failed: token mismatch or bad mode');
  res.sendStatus(403);
}
