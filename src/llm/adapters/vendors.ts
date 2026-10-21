import type { AdapterId } from './types';

/**
 * Vendor identity: who the provider is, which adapter speaks its API, its OFFICIAL base URL and hosts, how its free tier can be known.
 * Everything here comes from the vendor's own documentation; a model id is a default ONLY when it was seen in that vendor's live
 * model-list answer (`verifiedDefault`) or documented as a stable alias (`probeModels`) — and even then it is used only after a real minimal
 * inference confirmed it when the key was saved; otherwise the administrator types one. Nothing is assumed free: the
 * only automatic price evidence is OpenRouter's public catalog; every other vendor needs the administrator's confirmation.
 */
export type FreeEligibility =
  | { mode: 'catalog'; note: string } // price evidence comes from the vendor's model list
  | { mode: 'admin_confirmation'; note: string }; // nothing machine-readable: an administrator must confirm

export interface Vendor {
  id: string;
  name: string;
  adapter: AdapterId;
  kind: 'openrouter' | 'openai_compatible';
  baseUrl: string;
  /** Hosts the official API lives on; a known vendor refuses any other address (a web page such as a console URL is never an API). */
  hosts: string[];
  docs: string;
  /** Key prefix used only to pre-select the vendor when a key is pasted. */
  keyPrefix?: RegExp;
  /** Model ids seen in the vendor's live list (with the date); empty = the administrator types one. */
  verifiedDefault: string;
  verifiedOn?: string;
  /**
   * Models tried, in order, by the automatic setup when a key is saved (one real minimal inference each; the first that answers is kept). Only
   * ids the vendor documents as stable aliases belong here; empty = the administrator must type a model id.
   */
  probeModels: string[];
  /**
   * Completion-token budget of a VALIDATION request (a provider test, the automatic model setup, a recovery probe). Default 8: enough for one word. A vendor whose
   * models reason before answering needs more, or the whole budget goes on hidden reasoning and the answer is empty (Groq's openai/gpt-oss-20b: empty at 8, answers at 256).
   */
  validationTokens?: number;
  /** Completion-token budget of a normal customer reply (default 600). A reasoning model needs room for its hidden reasoning AND the answer. */
  chatTokens?: number;
  free: FreeEligibility;
  hint: string;
}

export const VENDORS: Vendor[] = [
  { id: 'openrouter', name: 'OpenRouter', adapter: 'openrouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', hosts: ['openrouter.ai'], docs: 'https://openrouter.ai/docs', keyPrefix: /^sk-or-/, verifiedDefault: 'openrouter/free', probeModels: ['openrouter/free'],
    free: { mode: 'catalog', note: 'OpenRouter\'s public model list carries per-token prices; a model is free only when both are 0. Free models also need the account privacy setting to allow them.' },
    hint: 'Free models end in :free (or use openrouter/free). The account privacy setting must allow free (non-ZDR) endpoints.' },
  { id: 'groq', name: 'Groq', adapter: 'openai', kind: 'openai_compatible', baseUrl: 'https://api.groq.com/openai/v1', hosts: ['api.groq.com'], docs: 'https://console.groq.com/docs', keyPrefix: /^gsk_/, verifiedDefault: 'openai/gpt-oss-20b', verifiedOn: '2026-10-18', probeModels: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'], validationTokens: 256, chatTokens: 1000,
    free: { mode: 'admin_confirmation', note: 'Groq has a free plan with rate limits, but its API does not say which plan a key is on: confirm it yourself.' },
    hint: 'Groq (not xAI Grok). API address https://api.groq.com/openai/v1; get the key at console.groq.com/keys (that page is not the API address).' },
  { id: 'google', name: 'Google AI Studio (Gemini)', adapter: 'gemini', kind: 'openai_compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', hosts: ['generativelanguage.googleapis.com'], docs: 'https://ai.google.dev/api', keyPrefix: /^AIza/, verifiedDefault: '', probeModels: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-3.8-flash'],
    free: { mode: 'admin_confirmation', note: 'The Gemini API has a free tier for some models; the model list does not say which. Check your key\'s rate-limit page, then confirm.' },
    hint: 'Native Gemini API (generateContent). The model is chosen automatically: when you save, the key is tested with a real request.' },
  { id: 'xai', name: 'xAI (Grok)', adapter: 'openai', kind: 'openai_compatible', baseUrl: 'https://api.x.ai/v1', hosts: ['api.x.ai'], docs: 'https://docs.x.ai', keyPrefix: /^xai-/, verifiedDefault: '', probeModels: [],
    free: { mode: 'admin_confirmation', note: 'xAI documents no free API tier. Confirm only if you have verified that your key is not billed.' },
    hint: 'xAI Grok (not Groq). API address https://api.x.ai/v1. Type a model id under More options; it is tested with a real request when you save.' },
  { id: 'mistral', name: 'Mistral', adapter: 'openai', kind: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1', hosts: ['api.mistral.ai'], docs: 'https://docs.mistral.ai/api', verifiedDefault: '', probeModels: ['mistral-small-latest'],
    free: { mode: 'admin_confirmation', note: 'Mistral offers a free experiment plan with rate limits and data-use terms; the API does not say which plan a key is on: confirm it yourself.' },
    hint: 'API address https://api.mistral.ai/v1. The model is chosen automatically: when you save, the key is tested with a real request.' },
  { id: 'cerebras', name: 'Cerebras', adapter: 'openai', kind: 'openai_compatible', baseUrl: 'https://api.cerebras.ai/v1', hosts: ['api.cerebras.ai'], docs: 'https://inference-docs.cerebras.ai', keyPrefix: /^csk-/, verifiedDefault: '', probeModels: [],
    free: { mode: 'admin_confirmation', note: 'Cerebras has a free tier with limits; confirm it yourself.' },
    hint: 'API address https://api.cerebras.ai/v1. Type a model id under More options; it is tested with a real request when you save.' },
  { id: 'custom', name: 'Custom OpenAI-compatible', adapter: 'openai', kind: 'openai_compatible', baseUrl: '', hosts: [], docs: '', verifiedDefault: '', probeModels: [],
    free: { mode: 'admin_confirmation', note: 'An unknown endpoint: confirm its free tier yourself.' },
    hint: 'Any API that implements /v1/chat/completions. The endpoint is its API base URL (not a web page) and the models are required.' },
];

export const vendorById = (id: string | null | undefined): Vendor | undefined => VENDORS.find((v) => v.id === id);

/** The vendor an API address belongs to ('custom' when it is none of the known official hosts). */
export function vendorForUrl(baseUrl: string): Vendor {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return VENDORS.find((v) => v.hosts.includes(host)) ?? vendorById('custom')!;
  } catch {
    return vendorById('custom')!;
  }
}

/** A known vendor must use its own official host: the Groq console's key page, for one, is not an API. Custom accepts any HTTPS address. */
export function endpointMatchesVendor(vendorId: string, baseUrl: string): boolean {
  const vendor = vendorById(vendorId);
  if (!vendor || vendor.id === 'custom') return true;
  try { return vendor.hosts.includes(new URL(baseUrl).hostname.toLowerCase()); } catch { return false; }
}
