import { describe, it, expect, vi } from 'vitest';
import { withRetry, HttpError, isRetryableHttpError } from '../../../src/utils/retry';

describe('withRetry', () => {
  it('returns the result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { retries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries on failure and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { retries: 3, baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops immediately for a non-retryable (permanent) error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent'));
    await expect(
      withRetry(fn, { retries: 3, baseDelayMs: 1, isRetryable: () => false }),
    ).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('isRetryableHttpError', () => {
  it('treats 5xx as retryable', () => {
    expect(isRetryableHttpError(new HttpError('x', 500))).toBe(true);
    expect(isRetryableHttpError(new HttpError('x', 503))).toBe(true);
  });

  it('treats 429 and 408 as retryable', () => {
    expect(isRetryableHttpError(new HttpError('x', 429))).toBe(true);
    expect(isRetryableHttpError(new HttpError('x', 408))).toBe(true);
  });

  it('treats other 4xx as permanent (not retryable)', () => {
    expect(isRetryableHttpError(new HttpError('x', 400))).toBe(false);
    expect(isRetryableHttpError(new HttpError('x', 401))).toBe(false);
    expect(isRetryableHttpError(new HttpError('x', 404))).toBe(false);
  });

  it('treats non-HttpError (network) errors as retryable', () => {
    expect(isRetryableHttpError(new TypeError('network error'))).toBe(true);
  });
});
