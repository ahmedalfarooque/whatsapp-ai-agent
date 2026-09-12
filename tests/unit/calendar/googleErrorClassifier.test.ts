import { describe, it, expect } from 'vitest';
import { isConfirmedGoogleFailure } from '../../../src/calendar/googleErrorClassifier';

describe('isConfirmedGoogleFailure', () => {
  it('treats a clean 4xx (gaxios-style response.status) as a confirmed failure', () => {
    const error = Object.assign(new Error('Bad Request'), { response: { status: 400 } });
    expect(isConfirmedGoogleFailure(error)).toBe(true);
  });

  it('treats a clean 4xx via a top-level .status as confirmed', () => {
    const error = Object.assign(new Error('Not Found'), { status: 404 });
    expect(isConfirmedGoogleFailure(error)).toBe(true);
  });

  it('treats 401/403 auth errors as confirmed failures', () => {
    expect(isConfirmedGoogleFailure(Object.assign(new Error('x'), { response: { status: 401 } }))).toBe(true);
    expect(isConfirmedGoogleFailure(Object.assign(new Error('x'), { response: { status: 403 } }))).toBe(true);
  });

  it('treats 429 as ambiguous, not confirmed', () => {
    const error = Object.assign(new Error('Too Many Requests'), { response: { status: 429 } });
    expect(isConfirmedGoogleFailure(error)).toBe(false);
  });

  it('treats 408 as ambiguous, not confirmed', () => {
    const error = Object.assign(new Error('Request Timeout'), { response: { status: 408 } });
    expect(isConfirmedGoogleFailure(error)).toBe(false);
  });

  it('treats any 5xx as ambiguous, not confirmed', () => {
    for (const status of [500, 502, 503, 504]) {
      const error = Object.assign(new Error('server error'), { response: { status } });
      expect(isConfirmedGoogleFailure(error)).toBe(false);
    }
  });

  it('treats a plain network error (no HTTP status at all) as ambiguous', () => {
    expect(isConfirmedGoogleFailure(new Error('ECONNRESET'))).toBe(false);
    expect(isConfirmedGoogleFailure(new TypeError('fetch failed'))).toBe(false);
  });

  it('treats a timeout/abort error as ambiguous', () => {
    expect(isConfirmedGoogleFailure(new DOMException('aborted', 'AbortError'))).toBe(false);
  });

  it('treats a non-Error thrown value with no status as ambiguous, never throws itself', () => {
    expect(isConfirmedGoogleFailure('a plain string')).toBe(false);
    expect(isConfirmedGoogleFailure(null)).toBe(false);
    expect(isConfirmedGoogleFailure(undefined)).toBe(false);
    expect(isConfirmedGoogleFailure({})).toBe(false);
  });

  it("does not confuse a Node error .code string (e.g. 'ECONNRESET') with a numeric HTTP status", () => {
    const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(isConfirmedGoogleFailure(error)).toBe(false);
  });
});
