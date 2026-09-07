export {
  claimWebhookEvent,
  markWebhookEventProcessed,
  markWebhookEventFailed,
} from '../memory/webhookEventRepo';

/**
 * Serializes processing per WhatsApp number so two near-simultaneous
 * deliveries for the same customer (e.g. a fast double-send, or a Meta
 * retry racing the original request) can never run the agent loop /
 * booking logic concurrently and corrupt conversation or booking state.
 * Unrelated customers are never blocked by each other.
 */
const queueTails = new Map<string, Promise<void>>();

export function withCustomerLock<T>(waId: string, fn: () => Promise<T>): Promise<T> {
  const priorTail = queueTails.get(waId) ?? Promise.resolve();
  const result = priorTail.then(fn, fn);

  const nextTail = result.then(
    () => undefined,
    () => undefined,
  );
  queueTails.set(waId, nextTail);
  nextTail.finally(() => {
    if (queueTails.get(waId) === nextTail) {
      queueTails.delete(waId);
    }
  });

  return result;
}
