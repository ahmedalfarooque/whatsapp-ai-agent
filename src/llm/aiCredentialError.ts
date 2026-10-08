/**
 * The AI provider cannot be used because of its CREDENTIAL (not set, not a usable key, or refused by the provider). It is never
 * retried (retrying the same key cannot help), carries no secret, and tells the administrator what to do.
 * Kept in its own module so the pipeline can recognise it without depending on the provider client.
 */
export class AiCredentialError extends Error {
  constructor(
    message: string,
    public readonly reason: 'missing' | 'malformed' | 'rejected',
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'AiCredentialError';
  }
}
