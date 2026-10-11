/**
 * The AI provider answered (or failed to answer) in a way that gives the customer nothing usable. Distinct from AiCredentialError
 * (the key itself is the problem). It carries only safe diagnostics: a category, the HTTP status, the model name and a short
 * provider message — never the key, the prompt or the customer's text.
 */
export type AiResponseReason =
  | 'empty_response' // HTTP 200 but no text (and no tool call)
  | 'malformed_response' // not JSON, no choices, no message
  | 'rate_limited' // HTTP 429 / 408
  | 'model_unavailable' // HTTP 400-404: this model/endpoint cannot serve the request (e.g. privacy or data-policy restrictions)
  | 'provider_error' // HTTP 5xx or another failure
  | 'tool_rounds_exhausted'; // the model kept calling tools and never answered

export class AiResponseError extends Error {
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
    return `${this.reason.replace(/_/g, ' ')}${this.httpStatus ? `, HTTP ${this.httpStatus}` : ''}${this.model ? `, model ${this.model}` : ''}`;
  }
}

export function reasonForHttpStatus(status: number): AiResponseReason {
  if (status === 429 || status === 408) return 'rate_limited';
  if (status >= 500) return 'provider_error';
  if (status >= 400) return 'model_unavailable';
  return 'provider_error';
}
