import { AiCredentialError } from './aiCredentialError';
import { AiResponseError, type AiResponseReason, type ModelAttemptRecord } from './aiResponseError';
import { getModelInfo, type ModelInfo } from './modelCatalog';

/**
 * Bounded, honest model fallback for the OpenRouter client.
 *
 *  - A failure is classified first. Only a MODEL-SPECIFIC failure (this model refused the request, answered nothing, is rate limited or
 *    its provider is down) justifies trying another model. An ACCOUNT-WIDE failure (the key is rejected, a network problem) is never
 *    "solved" by switching: it is reported as what it is. An HTTP 402 (credit-derived token cap / credit exhausted) is account-wide for
 *    every PAID model, but a FREE model (price 0 in OpenRouter's catalog) is not charged, so one free fallback may be tried once; when
 *    the free fallback also fails (402, or the account's data policy blocks free endpoints: HTTP 404) the account is marked
 *    "free fallback blocked" for a cooldown and nothing else is tried.
 *  - Every model that failed for a model-specific reason enters a short cooldown so a dead model is not tried on every message.
 *  - At most ONE fallback model is tried per request, and only with the capabilities the request needs (tools, image, audio).
 */

export type FailureClass = 'account' | 'credit' | 'model' | 'network';

export type ModelAttempt = ModelAttemptRecord;

const MODEL_COOLDOWN_MS: Partial<Record<AiResponseReason, number>> = {
  model_unavailable: 5 * 60_000,
  provider_error: 60_000,
  rate_limited: 60_000,
  empty_response: 30_000,
  malformed_response: 30_000,
};
export const FREE_FALLBACK_BLOCKED_MS = 30 * 60_000;

const cooling = new Map<string, number>(); // model -> until (epoch ms)
let freeFallbackBlockedUntil = 0;
let freeFallbackBlockedWhy: string | null = null;

export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof AiCredentialError) return 'account';
  if (error instanceof AiResponseError) {
    if (error.network) return 'network';
    if (error.reason === 'payment_required') return 'credit';
    if (error.reason === 'time_budget_exceeded' || error.reason === 'tool_rounds_exhausted') return 'account';
    return 'model';
  }
  return 'account';
}

export function markModelFailure(model: string, reason: AiResponseReason, now = Date.now()): void {
  const ms = MODEL_COOLDOWN_MS[reason];
  if (ms) cooling.set(model, now + ms);
}

export function isModelCooling(model: string, now = Date.now()): boolean {
  const until = cooling.get(model);
  if (until === undefined) return false;
  if (until <= now) { cooling.delete(model); return false; }
  return true;
}

export function markFreeFallbackBlocked(why: string, now = Date.now()): void {
  freeFallbackBlockedUntil = now + FREE_FALLBACK_BLOCKED_MS;
  freeFallbackBlockedWhy = why;
}

export function freeFallbackBlocked(now = Date.now()): string | null {
  if (freeFallbackBlockedUntil <= now) return null;
  return freeFallbackBlockedWhy ?? 'blocked';
}

export interface FallbackNeeds { tools: boolean; image: boolean; audio: boolean }

/**
 * The ONE fallback model to try after `failed` failed with `failure`, or null with the reason none applies. `candidates` is the business's
 * list in order; a candidate is skipped while cooling, when the catalog says it lacks a needed capability (image/audio must be KNOWN to be
 * supported; tools and unknown models are allowed for plain text), and after a 402 unless the catalog says it is free.
 */
export async function chooseFallback(failed: string, candidates: string[], failure: FailureClass, needs: FallbackNeeds, now = Date.now()): Promise<{ model: string; info: ModelInfo | null } | { model: null; skipped: string }> {
  if (failure === 'account' || failure === 'network') return { model: null, skipped: failure === 'account' ? 'account-wide failure: switching models cannot help' : 'network failure: switching models cannot help' };
  if (failure === 'credit') {
    const blocked = freeFallbackBlocked(now);
    if (blocked) return { model: null, skipped: `free fallback blocked for this account (${blocked})` };
  }
  const skipped: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || candidate === failed) continue;
    if (isModelCooling(candidate, now)) { skipped.push(`${candidate}: cooling down after a recent failure`); continue; }
    const info = await getModelInfo(candidate);
    if (failure === 'credit' && !info?.free) { skipped.push(`${candidate}: ${info ? 'not free' : 'price unknown'}, a 402 would repeat`); continue; }
    if (needs.image && !info?.image) { skipped.push(`${candidate}: ${info ? 'no image input' : 'capabilities unknown'}`); continue; }
    if (needs.audio && !info?.audio) { skipped.push(`${candidate}: ${info ? 'no audio input' : 'capabilities unknown'}`); continue; }
    if (needs.tools && info && !info.tools) { skipped.push(`${candidate}: no tool calling`); continue; }
    return { model: candidate, info };
  }
  return { model: null, skipped: skipped.length ? skipped.join('; ') : 'no fallback model configured' };
}

/** One line for logs/activity naming every model tried and why it failed — never the prompt, the key or customer text. */
export function describeAttempts(attempts: ModelAttempt[]): string {
  return attempts.map((a) => `${a.model} (${a.reason === 'credential' ? 'key rejected' : a.reason.replace(/_/g, ' ')}${a.httpStatus ? `, HTTP ${a.httpStatus}` : ''})`).join(' → ');
}

export function resetModelFallbackForTests(): void {
  cooling.clear();
  freeFallbackBlockedUntil = 0;
  freeFallbackBlockedWhy = null;
}
