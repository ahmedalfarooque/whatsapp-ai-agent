/**
 * The AI provider answered (or failed to answer) in a way that gives the customer nothing usable. Distinct from AiCredentialError
 * (the key itself is the problem). It carries only safe diagnostics: a category, the HTTP status, the model name and a short
 * provider message — never the key, the prompt or the customer's text.
 */
export type AiResponseReason =
  | 'empty_response' // HTTP 200 but no text (and no tool call)
  | 'malformed_response' // not JSON, no choices, no message
  | 'rate_limited' // HTTP 429 / 408
  | 'payment_required' // HTTP 402: the OpenRouter credit is exhausted or too low for this prompt ("Prompt tokens limit exceeded")
  | 'model_unavailable' // HTTP 400-404: this model/endpoint cannot serve the request (e.g. privacy or data-policy restrictions, no image input)
  | 'provider_error' // HTTP 5xx or another failure
  | 'tool_rounds_exhausted' // the model kept calling tools and never answered
  | 'time_budget_exceeded'; // the whole AI loop for one message ran out of time

/** One model that was tried for a request and how it failed (safe diagnostics only). */
export interface ModelAttemptRecord { model: string; reason: AiResponseReason | 'credential'; httpStatus: number | null; providerMessage?: string | null }

export class AiResponseError extends Error {
  /** Set by the agent loop when the failure came on a round AFTER tool calls were requested: the whole loop must then never be re-run (a tool may already have acted). */
  afterToolCalls = false;
  /** True when no HTTP answer arrived at all (connection refused, DNS, abort/timeout): a provider-side or network problem, not this model's. */
  network = false;
  /** Every model tried for this request, in order (the primary first, then at most one fallback), each with its own failure. */
  attempts: ModelAttemptRecord[] = [];
  /** Why no fallback model was tried (none configured, cooling, wrong capabilities, free fallback blocked, account-wide failure). */
  fallbackSkipped: string | null = null;
  /** The provider's Retry-After, in ms, when it sent one (rate limits); the router uses it for the route's cooldown. */
  retryAfterMs: number | null = null;
  /** Where that time comes from: 'stated' = the provider's response says it (Retry-After, reset header, RetryInfo); 'documented' = the provider's published policy (e.g. Google's daily quota resets at midnight Pacific time) — the response carries no timestamp. */
  retryBasis: 'stated' | 'documented' | null = null;
  /** Set when the provider says THIS request is larger than its per-minute token limit allows ("Limit 8000, Requested 9234"): the size is the problem, not the route. */
  tokenLimit: { limit: number; requested: number } | null = null;

  constructor(
    public readonly reason: AiResponseReason,
    public readonly httpStatus: number | null,
    public readonly model: string | null,
    public readonly providerMessage: string | null = null,
  ) {
    super(`AI response problem: ${reason}${httpStatus ? ` (HTTP ${httpStatus})` : ''}${model ? ` model ${model}` : ''}`);
    this.name = 'AiResponseError';
  }

  /** Short text for the activity log shown in the dashboard. */
  describe(): string {
    const base = this.reason === 'payment_required'
      ? `OpenRouter credits exhausted or too low for this prompt, HTTP 402${this.model ? `, model ${this.model}` : ''}${this.providerMessage ? ` — ${this.providerMessage.slice(0, 120)}` : ''}`
      : `${this.reason.replace(/_/g, ' ')}${this.network ? ' (no answer from the provider)' : ''}${this.httpStatus ? `, HTTP ${this.httpStatus}` : ''}${this.model ? `, model ${this.model}` : ''}`;
    const others = this.attempts.filter((a, i) => a.model !== this.model && !(i === 0 && this.model && a.model.endsWith(` · ${this.model}`)));
    const tried = others.length ? `; also tried ${others.map((a) => `${a.model} (${a.reason === 'credential' ? 'key rejected' : a.reason.replace(/_/g, ' ')}${a.httpStatus ? `, HTTP ${a.httpStatus}` : ''})`).join(', ')}` : '';
    const skipped = this.fallbackSkipped ? `; no fallback: ${this.fallbackSkipped}` : '';
    return `${base}${tried}${skipped}`;
  }
}

export function reasonForHttpStatus(status: number): AiResponseReason {
  if (status === 429 || status === 408) return 'rate_limited';
  if (status === 402) return 'payment_required';
  if (status >= 500) return 'provider_error';
  if (status >= 400) return 'model_unavailable';
  return 'provider_error';
}
