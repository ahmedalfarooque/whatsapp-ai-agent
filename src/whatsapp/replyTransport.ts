import { AsyncLocalStorage } from 'node:async_hooks';
import type { OutboundDocument, OutboundImage, OutboundInteractiveMessage, SendTextMessageResponse } from './types';

export interface ReplyTransport {
  text(to: string, body: string): Promise<SendTextMessageResponse>;
  interactive(to: string, message: OutboundInteractiveMessage): Promise<SendTextMessageResponse>;
  /** Sends a file. Optional: a transport that cannot deliver documents (the Meta Cloud API one) simply omits it. */
  document?(to: string, document: OutboundDocument): Promise<SendTextMessageResponse>;
  /** Sends a picture as real image media. Optional for the same reason as document(). */
  image?(to: string, image: OutboundImage): Promise<SendTextMessageResponse>;
}

// Each inbound request keeps its own transport, including concurrent Cloud API replies.
export const replyTransport = new AsyncLocalStorage<ReplyTransport>();
