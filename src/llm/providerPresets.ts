import type { AiProviderInput, ProviderKind } from './providerRepo';
import { csv } from './providerRepo';

/**
 * Presets for the endpoints a business or the Super Admin can add with just a NAME and an API CONFIGURATION (an API key, or the address of a
 * local runtime). The preset supplies the base URL, the kind and example free models, so the simple form needs nothing else. The administrator
 * still chooses the models in "More options"; every provider added this way is declared as a FREE tier (the router uses it only in strict
 * free-only mode when declared so, and never calls anything it cannot show to be free).
 */
export interface ProviderPreset { id: string; name: string; kind: ProviderKind; baseUrl: string; hint: string; models: string; keyPrefix?: RegExp }

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'openrouter', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', hint: 'Free models end in :free and need the account privacy setting to allow non-ZDR endpoints.', models: 'openrouter/free', keyPrefix: /^sk-or-/ },
  { id: 'groq', name: 'Groq', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', hint: 'Free developer tier (daily request limits, no card).', models: 'llama-3.3-70b-versatile,llama-3.1-8b-instant', keyPrefix: /^gsk_/ },
  { id: 'google', name: 'Google AI Studio (Gemini)', kind: 'openai_compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', hint: 'Free tier of the Gemini API (daily limits, no card). Free-tier prompts may be used by Google to improve its products.', models: 'gemini-2.5-flash-lite,gemini-2.5-flash', keyPrefix: /^AIza/ },
  { id: 'cerebras', name: 'Cerebras', kind: 'openai_compatible', baseUrl: 'https://api.cerebras.ai/v1', hint: 'Free tier (daily token limits).', models: 'llama-3.3-70b,llama3.1-8b', keyPrefix: /^csk-/ },
  { id: 'mistral', name: 'Mistral', kind: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1', hint: 'Free experiment tier (rate limited; data may be used for training).', models: 'mistral-small-latest' },
  { id: 'ollama', name: 'Local Ollama', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', hint: 'A model running on this server (no key, no cost, slow on a CPU; never a public address). Customer replies stay off until it passes the latency and quality bar.', models: 'qwen2.5:3b-instruct-q4_K_M' },
  { id: 'custom', name: 'Custom OpenAI-compatible', kind: 'openai_compatible', baseUrl: '', hint: 'Any /v1/chat/completions endpoint.', models: '' },
];

export class SimpleProviderError extends Error {
  constructor(message: string, public readonly fields: string[]) {
    super(message);
    this.name = 'SimpleProviderError';
  }
}

const isUrl = (s: string): boolean => /^https?:\/\//i.test(s);

/** The preset a key belongs to, recognised from its prefix (never stored or logged). */
export function detectPresetId(config: string): string | null {
  const value = config.trim();
  if (isUrl(value)) return null;
  return PROVIDER_PRESETS.find((p) => p.keyPrefix?.test(value))?.id ?? null;
}

/**
 * The full provider input for the two-field form. `config` is an API key (the preset is recognised from its prefix, or named in `provider`)
 * or, for a local runtime / custom endpoint, the endpoint's address. Anything the preset does not decide is refused with the field names, so
 * nothing is guessed.
 */
export function resolveSimpleProvider(input: { name: string; config: string; provider?: string; models?: string; baseUrl?: string; timeoutMs?: number; enabled?: boolean }): AiProviderInput {
  const config = (input.config ?? '').trim();
  const asked = (input.provider ?? '').trim();
  const presetId = asked && asked !== 'auto' ? asked : isUrl(config) ? (/:(11434)(\/|$)/.test(config) || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(config) ? 'ollama' : 'custom') : detectPresetId(config);
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new SimpleProviderError('provider_required', ['provider']);
  const models = csv(input.models) .length ? csv(input.models) : csv(preset.models);
  const urlConfig = isUrl(config);
  let baseUrl = input.baseUrl?.trim() || (urlConfig ? config : preset.baseUrl);
  if (preset.kind === 'ollama' && urlConfig && !/\/v1\/?$/.test(baseUrl)) baseUrl = `${baseUrl.replace(/\/+$/, '')}/v1`;
  if (preset.kind !== 'ollama' && urlConfig && !input.baseUrl) throw new SimpleProviderError('validation_failed', ['config']); // a cloud endpoint is selected by its key, not by pasting a URL
  return {
    name: input.name,
    kind: preset.kind,
    baseUrl,
    apiKey: preset.kind === 'ollama' || urlConfig ? undefined : config,
    models,
    freeTier: true,
    supportsTools: true,
    // A local model is created SWITCHED OFF: on this server's CPU it has not met the latency / quality bar for customer replies, so it is never
    // enabled by accident. It can still be tested; turning it on is a deliberate act (the dashboard asks to confirm).
    enabled: input.enabled !== undefined ? input.enabled : preset.kind !== 'ollama',
    timeoutMs: input.timeoutMs ?? (preset.kind === 'ollama' ? 45000 : 20000),
  };
}
