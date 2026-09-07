import { Router, type Request, type Response } from 'express';
import { logger, maskWaId } from '../logger';
import { verifySignatureMiddleware } from './verifySignature';
import { handleWebhookVerification } from './verifyToken';
import { parseInboundPayload } from './parseInboundPayload';
import { claimWebhookEvent, markWebhookEventProcessed, markWebhookEventFailed } from '../pipeline/idempotency';
import { processInboundMessage, type ProcessDependencies } from '../pipeline/processInboundMessage';

export function createWebhookRouter(deps: ProcessDependencies): Router {
  const router = Router();

  router.get('/webhook', handleWebhookVerification);

  router.post('/webhook', verifySignatureMiddleware, (req: Request, res: Response) => {
    // Ack fast — Meta expects a sub-second 200 and will retry on timeout/non-200.
    res.sendStatus(200);

    let messages;
    try {
      messages = parseInboundPayload(req.body);
    } catch (error) {
      logger.error({ error }, 'failed to parse inbound webhook payload');
      return;
    }

    for (const msg of messages) {
      const claimed = claimWebhookEvent(msg.messageId, `${msg.type} from ${maskWaId(msg.waId)}`);
      if (!claimed) {
        logger.info({ messageId: msg.messageId }, 'duplicate webhook delivery ignored');
        continue;
      }

      processInboundMessage(msg, deps)
        .then(() => markWebhookEventProcessed(msg.messageId))
        .catch((error) => {
          logger.error({ messageId: msg.messageId, error }, 'unhandled error processing inbound message');
          markWebhookEventFailed(msg.messageId, error instanceof Error ? error.message : String(error));
        });
    }
  });

  return router;
}
