/**
 * OpenRouter answers HTTP 402 "Prompt tokens limit exceeded: N > CAP" when the remaining credit only covers CAP prompt tokens (the cap
 * shrinks as the credit drains). The message names both numbers, so the pipeline can shrink the knowledge/history it sends to fit and try
 * once more instead of failing every message. Nothing here spends money or changes model: it only sends LESS text.
 */

const CAP_PATTERN = /prompt tokens limit exceeded:\s*(\d+)\s*>\s*(\d+)/i;
const SAFETY = 0.7; // aim well below the cap: the estimate is rough and the fixed part of the prompt (rules, profile, tools) does not shrink
const MIN_SCALE = 0.1;
const REMEMBER_MS = 30 * 60 * 1000;

export interface PromptCap { used: number; cap: number }

export function parsePromptCap(providerMessage: string | null | undefined): PromptCap | null {
  const match = providerMessage ? CAP_PATTERN.exec(providerMessage) : null;
  if (!match) return null;
  const used = Number(match[1]);
  const cap = Number(match[2]);
  return used > 0 && cap > 0 && used > cap ? { used, cap } : null;
}

/** The factor (MIN_SCALE..0.9) to apply to the knowledge and history character budgets so the prompt fits under the cap. */
export function scaleForCap({ used, cap }: PromptCap): number {
  return Math.min(0.9, Math.max(MIN_SCALE, (cap * SAFETY) / used));
}

const learned = new Map<number, { scale: number; at: number }>();

/** Remember, per business account, the scale that the provider's cap demands; later messages start from it instead of failing first. */
export function rememberPromptScale(accountId: number, scale: number, now = Date.now()): void {
  learned.set(accountId, { scale, at: now });
}

/** 1 when nothing is known (or the memory is stale: credit may have been topped up), else the remembered scale. */
export function currentPromptScale(accountId: number, now = Date.now()): number {
  const entry = learned.get(accountId);
  if (!entry) return 1;
  if (now - entry.at > REMEMBER_MS) { learned.delete(accountId); return 1; }
  return entry.scale;
}

export function resetPromptScalesForTests(): void { learned.clear(); }
