import type { ToolDefinition } from '../../tools';
import type { ChatCompletionResponse, ChatMessage } from '../types';

/**
 * A provider adapter owns everything that is specific to one vendor's API contract: how a request is serialised, how the answer is parsed,
 * how the key is sent, how models are listed and how HTTP failures are normalised. The router knows only this interface: it never builds a
 * vendor request itself, so a new vendor is one new adapter plus one registry entry.
 *
 * Every adapter reports failures as the SAME normalised errors (AiCredentialError for a rejected key or missing permission; AiResponseError
 * with a reason for everything else) so failover, cooldowns and retries behave identically whatever the vendor.
 */
export type AdapterId = 'openrouter' | 'openai' | 'gemini';

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

/** One model as the provider's own model-list API reports it. `free` is true/false ONLY when the list itself carries reliable price evidence. */
export interface DiscoveredModel {
  id: string;
  label?: string;
  contextLength?: number;
  /** e.g. "text,image → text" when the provider says so. */
  modalities?: string;
  free: boolean | null;
  /** Why `free` is what it is, in words (never a guess). */
  evidence: string;
}

export interface DiscoveryContext { baseUrl: string; apiKey: string | null; timeoutMs: number }

export type DiscoveryFailure = 'credential' | 'endpoint_not_found' | 'rate_limited' | 'provider_error' | 'network' | 'malformed';

export class ModelDiscoveryError extends Error {
  constructor(public readonly category: DiscoveryFailure, public readonly httpStatus: number | null, message: string) {
    super(message);
    this.name = 'ModelDiscoveryError';
  }
}

export interface ProviderAdapter {
  readonly id: AdapterId;
  /** Which header(s) carry the key — documentation for the dashboard, never the key. */
  readonly authentication: string;
  complete(request: AdapterCompleteRequest): Promise<ChatCompletionResponse>;
  /** The provider's documented model-list call. Never throws a raw error: always a ModelDiscoveryError. */
  listModels(context: DiscoveryContext): Promise<DiscoveredModel[]>;
}
