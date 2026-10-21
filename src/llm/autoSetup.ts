import { adapterFor, type Vendor } from './adapters';
import { AiCredentialError } from './aiCredentialError';
import { AiResponseError } from './aiResponseError';
import { sanitizeProviderReason } from '../dashboard/aiPoolState';
import { validationBudget } from './validationBudget';

/**
 * Automatic model selection when an API key is saved. No model list is fetched or trusted: a model counts only when ONE real, minimal inference
 * (a few tokens, a neutral prompt, no customer data) through the vendor's own adapter returned an answer. Candidates are the models typed by the
 * administrator, or else the vendor's `probeModels` (ids the vendor documents as stable aliases). Each candidate is called at most once, the
 * whole setup is bounded (MAX_PROBES), a rejected key stops it at once, and nothing is retried or routed around a quota.
 */
export const MAX_PROBES = 3;
export const MAX_TYPED_MODELS = 5;
const PROBE_PROMPT = 'Reply with the single word: ok';

export interface ProbeAttempt { model: string; ok: boolean; category: string; httpStatus: number | null; detail: string; latencyMs: number }

export type AutoSetupFailure = 'credential' | 'model_required' | 'rate_limited' | 'no_working_model' | 'network';

export type AutoSetupResult =
  | { ok: true; models: string[]; attempts: ProbeAttempt[] }
  | { ok: false; category: AutoSetupFailure; message: string; fields: string[]; attempts: ProbeAttempt[] };

type Classified = { category: string; httpStatus: number | null; detail: string };

function classify(error: unknown): Classified {
  if (error instanceof AiCredentialError) return { category: 'credential', httpStatus: error.httpStatus ?? null, detail: `the provider rejected the API key${error.httpStatus ? ` (HTTP ${error.httpStatus})` : ''}` };
  if (error instanceof AiResponseError) {
    const reason = sanitizeProviderReason(error.providerMessage);
    return { category: error.network ? 'network' : error.reason, httpStatus: error.httpStatus, detail: `${error.reason.replace(/_/g, ' ')}${error.httpStatus ? `, HTTP ${error.httpStatus}` : ''}${reason ? `: ${reason}` : ''}` };
  }
  return { category: 'network', httpStatus: null, detail: 'the provider could not be reached' };
}

async function probe(vendor: Vendor, baseUrl: string, apiKey: string, model: string, timeoutMs: number): Promise<ProbeAttempt> {
  const started = Date.now();
  const budget = validationBudget(vendor.id, baseUrl);
  let last: ProbeAttempt | null = null;
  // The vendor's own budget first; an EMPTY answer (a reasoning model that spent its budget thinking) is a failed validation, retried ONCE with a bounded larger budget.
  for (const maxTokens of [budget.first, budget.retry]) {
    try {
      await adapterFor(vendor.adapter).complete({ baseUrl, apiKey, model, messages: [{ role: 'user', content: PROBE_PROMPT }], maxTokens, temperature: 0, timeoutMs });
      return { model, ok: true, category: 'ok', httpStatus: 200, detail: maxTokens === budget.first ? 'answered' : `answered with a budget of ${maxTokens} tokens`, latencyMs: Date.now() - started };
    } catch (error) {
      const c = classify(error);
      last = { model, ok: false, category: c.category, httpStatus: c.httpStatus, detail: c.detail, latencyMs: Date.now() - started };
      if (c.category !== 'empty_response' || budget.retry <= maxTokens) break;
    }
  }
  return last!;
}

const sentence = (a: ProbeAttempt): string => `${a.model}: ${a.detail}`;

/**
 * Chooses the model(s) a new provider will use. `typed` are models the administrator entered (all are checked, in order; those that answered are
 * kept). With none typed, the vendor's documented probe models are tried one by one until one answers.
 */
export async function autoSelectModel(vendor: Vendor, baseUrl: string, apiKey: string, typed: string[] = [], timeoutMs = 15_000): Promise<AutoSetupResult> {
  const explicit = typed.length > 0;
  const candidates = (explicit ? typed.slice(0, MAX_TYPED_MODELS) : vendor.probeModels.slice(0, MAX_PROBES));
  if (candidates.length === 0) {
    return { ok: false, category: 'model_required', fields: ['models'], attempts: [], message: `${vendor.name} has no model that is confirmed to be usable by default: type one model id under More options and the key will be tested with it.` };
  }
  const attempts: ProbeAttempt[] = [];
  const answered: string[] = [];
  for (const model of candidates) {
    const attempt = await probe(vendor, baseUrl, apiKey, model, timeoutMs);
    attempts.push(attempt);
    if (attempt.ok) {
      answered.push(model);
      if (!explicit) break; // one confirmed default is enough
      continue;
    }
    // A rejected key or an unreachable provider ends the setup: another model cannot help, and the key must not be hammered.
    if (attempt.category === 'credential') return { ok: false, category: 'credential', fields: ['config'], attempts, message: `The API key was rejected by ${vendor.name} (HTTP ${attempt.httpStatus ?? '?'}). Check that you pasted the whole key for this provider. Nothing was saved.` };
    if (attempt.category === 'network') return { ok: false, category: 'network', fields: [], attempts, message: `${vendor.name} could not be reached, so no model could be confirmed. Nothing was saved; try again in a moment.` };
  }
  if (answered.length > 0) return { ok: true, models: answered, attempts };
  const limited = attempts.length > 0 && attempts.every((a) => a.category === 'rate_limited' || a.category === 'payment_required');
  const shown = attempts.map(sentence).join('; ');
  if (limited) return { ok: false, category: 'rate_limited', fields: [], attempts, message: `The key looks valid but ${vendor.name}'s free allowance is used up right now, so no model could be confirmed (${shown}). Nothing was saved and nothing is retried; add it again after the allowance resets.` };
  return { ok: false, category: 'no_working_model', fields: explicit ? ['models'] : [], attempts, message: `No model answered a real test request (${shown}). Nothing was saved.${explicit ? ' Check the model ids you typed.' : ' Type a model id under More options.'}` };
}
