import type { AiProviderInput, ProviderKind } from './providerRepo';
import { csv, PROVIDER_RULES } from './providerRepo';
import { adapterFor, VENDORS } from './adapters';

/**
 * Presets for the endpoints a business or the Super Admin can add with just a NAME and an API CONFIGURATION (an API key, or the address of a
 * local runtime). The preset supplies the base URL, the kind and example free models, so the simple form needs nothing else. The administrator
 * still chooses the models in "More options"; every provider added this way is declared as a FREE tier (the router uses it only in strict
 * free-only mode when declared so, and never calls anything it cannot show to be free).
 */
export interface ProviderPreset { id: string; name: string; kind: ProviderKind; baseUrl: string; hint: string; models: string; keyPrefix?: RegExp; adapter: string; free: { mode: string; note: string }; docs: string; authentication: string; autoSelect: boolean }

// The presets ARE the vendor registry (src/llm/adapters/vendors.ts): official address, adapter, free-tier evidence. `models` holds only a model id
// that was seen in the vendor's live model list. The model a provider really uses is chosen by a real inference test when the key is saved (src/llm/autoSetup.ts).
export const PROVIDER_PRESETS: ProviderPreset[] = VENDORS.map((v) => ({
  id: v.id, name: v.name, kind: v.kind, baseUrl: v.baseUrl, hint: v.hint, models: v.verifiedDefault, keyPrefix: v.keyPrefix, adapter: v.adapter, free: v.free, docs: v.docs,
  authentication: adapterFor(v.adapter).authentication, autoSelect: v.probeModels.length > 0,
}));
/** What the dashboard form needs: presets (with the key prefix as a regex source) and the exact validation rules the server applies. */
export function presetsPayload(): { presets: Array<{ id: string; name: string; kind: ProviderKind; baseUrl: string; hint: string; models: string; adapter: string; free: { mode: string; note: string }; docs: string; authentication: string; autoSelect: boolean }>; rules: { baseUrl: string; model: string } } {
  return {
    presets: PROVIDER_PRESETS.map((p) => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, hint: p.hint, models: p.models, adapter: p.adapter, free: p.free, docs: p.docs, authentication: p.authentication, autoSelect: p.autoSelect })),
    rules: { baseUrl: PROVIDER_RULES.baseUrl.source, model: PROVIDER_RULES.model.source },
  };
}

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
 * (a custom endpoint also needs its HTTPS address under "More options"). Anything the preset does not decide is refused with the field
 * names, so nothing is guessed.
 */
export function resolveSimpleProvider(input: { name: string; config: string; provider?: string; models?: string; baseUrl?: string; timeoutMs?: number; enabled?: boolean }, options: { autoModel?: boolean } = {}): AiProviderInput {
  const config = (input.config ?? '').trim();
  const asked = (input.provider ?? '').trim();
  const presetId = asked && asked !== 'auto' ? asked : isUrl(config) ? 'custom' : detectPresetId(config);
  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new SimpleProviderError('provider_required', ['provider']);
  // autoModel: the models are chosen by a real inference test right after this (src/llm/autoSetup.ts), so only models the person typed count here.
  const models = csv(input.models).length ? csv(input.models) : options.autoModel ? [] : csv(preset.models);
  const baseUrl = input.baseUrl?.trim() || preset.baseUrl;
  if (isUrl(config)) throw new SimpleProviderError('validation_failed', ['config']); // an endpoint is selected by its key (and "More options"), not by pasting a URL
  // Nothing is guessed: a custom endpoint must say where it is and which models to call (a known provider fills both in), and both must be valid.
  const fields: string[] = [];
  if (!PROVIDER_RULES.baseUrl.test(baseUrl)) fields.push('baseUrl');
  // A vendor with a documented stable model (autoSelect) may leave the models empty; any other (custom, xAI, Cerebras) must be told one.
  if ((models.length === 0 && !(options.autoModel && preset.autoSelect)) || models.some((m) => !PROVIDER_RULES.model.test(m))) fields.push('models');
  if (fields.length) throw new SimpleProviderError('validation_failed', fields);
  return {
    name: input.name,
    kind: preset.kind,
    adapter: preset.adapter,
    vendor: preset.id,
    baseUrl,
    apiKey: config,
    models,
    freeTier: true,
    supportsTools: true,
    enabled: input.enabled !== false,
    timeoutMs: input.timeoutMs ?? 20000,
  };
}
