import type { ToolDefinition } from '../../tools';
import type { ChatCompletionResponse, ChatMessage } from '../types';

/**
 * A provider adapter owns everything that is specific to one vendor's API contract: how a request is serialised, how the answer is parsed,
 * how the key is sent and how HTTP failures are normalised. The router knows only this interface: it never builds a
 * vendor request itself, so a new vendor is one new adapter plus one registry entry.
 *
 * Every adapter reports failures as the SAME normalised errors (AiCredentialError for a rejected key or missing permission; AiResponseError
 * with a reason for everything else) so failover, cooldowns and retries behave identically whatever the vendor.
 */
export type AdapterId = 'openrouter' | 'openai' | 'gemini' | 'anthropic';

export interface AdapterCompleteRequest {
  baseUrl: string;
  apiKey: string | null;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition['schema'][];
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
}

export interface ProviderAdapter {
  readonly id: AdapterId;
  /** Which header(s) carry the key — documentation for the dashboard, never the key. */
  readonly authentication: string;
  complete(request: AdapterCompleteRequest): Promise<ChatCompletionResponse>;
}
