import { vendorById, vendorForUrl } from './adapters';

/**
 * How many completion tokens a VALIDATION request may use. A validation request (provider test, automatic model setup, recovery probe) sends a neutral prompt
 * and no customer data, so a bounded larger budget is safe. The first attempt uses the vendor's own budget (8 tokens by default, 256 for Groq whose reasoning models
 * spend the budget on hidden reasoning); when the answer comes back EMPTY the validation is retried ONCE with a larger budget, never more than VALIDATION_RETRY_CAP.
 */
export const VALIDATION_DEFAULT_TOKENS = 8;
export const VALIDATION_RETRY_CAP = 1024;
export const CHAT_DEFAULT_TOKENS = 600;
/** The most a customer reply may ever be given, even after the one bounded escalation. */
export const CHAT_BUDGET_CAP = 2048;

/** The completion budget of a normal customer reply on this vendor (a reasoning model such as Groq's gpt-oss gets room for its reasoning plus the answer). */
export function chatBudget(vendorId: string | null | undefined, baseUrl = ''): number {
  const vendor = vendorById(vendorId) ?? vendorForUrl(baseUrl);
  return Math.min(vendor.chatTokens ?? CHAT_DEFAULT_TOKENS, CHAT_BUDGET_CAP);
}

export function validationBudget(vendorId: string | null | undefined, baseUrl = ''): { first: number; retry: number } {
  const vendor = vendorById(vendorId) ?? vendorForUrl(baseUrl);
  const first = vendor.validationTokens ?? VALIDATION_DEFAULT_TOKENS;
  return { first, retry: Math.min(Math.max(first * 4, 256), VALIDATION_RETRY_CAP) };
}
