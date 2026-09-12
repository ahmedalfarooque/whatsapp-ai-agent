/**
 * Distinguishes a CONFIRMED failure (Google definitely rejected the request
 * before creating anything — safe to release the booking lock and let a
 * fresh attempt proceed) from an AMBIGUOUS/uncertain outcome (a network
 * error, timeout, or abort — Google may or may not have actually created
 * the event before we lost the response). This distinction is the crux of
 * booking safety: releasing a lock after an ambiguous outcome could let a
 * retry create a real duplicate calendar event.
 *
 * Classification is intentionally conservative — anything without a clear,
 * synchronous rejection status from Google is treated as ambiguous:
 *   - 4xx (400/401/403/404/422 etc, EXCEPT 408/429): the server rejected the
 *     request outright before doing any work. Confirmed failure.
 *   - 408/429: the server may have started processing before responding.
 *     Treated as ambiguous, not confirmed.
 *   - 5xx: Google's own guidance is that a 5xx on a write does not guarantee
 *     the write didn't happen server-side. Ambiguous.
 *   - No HTTP status at all (network error, DNS failure, AbortError/timeout):
 *     we don't even know if the request reached Google. Ambiguous.
 */
export function isConfirmedGoogleFailure(error: unknown): boolean {
  const status = extractHttpStatus(error);
  if (status === undefined) return false;
  if (status === 408 || status === 429) return false;
  if (status >= 500) return false;
  return status >= 400 && status < 500;
}

function extractHttpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };

  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.response?.status === 'number') return candidate.response.status;
  // googleapis/gaxios sometimes surfaces the HTTP status as a numeric `code`
  // (this is distinct from Node's string error codes like 'ECONNRESET',
  // which the typeof check below correctly excludes).
  if (typeof candidate.code === 'number') return candidate.code;

  return undefined;
}
