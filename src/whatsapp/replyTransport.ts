import { AsyncLocalStorage } from 'node:async_hooks';
import type { OutboundInteractiveMessage, SendTextMessageResponse } from './types';

export interface ReplyTransport {
  text(to: string, body: string): Promise<SendTextMessageResponse>;
  interactive(to: string, message: OutboundInteractiveMessage): Promise<SendTextMessageResponse>;
}

// Each inbound request keeps its own transport, including concurrent Cloud API replies.
export const replyTransport = new AsyncLocalStorage<ReplyTransport>();
