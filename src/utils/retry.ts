export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return true if this error should be retried; false stops immediately (permanent error). */
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number) => void;
}

const DEFAULTS: Required<Omit<RetryOptions, 'onRetry'>> = {
  retries: 3,
  baseDelayMs: 300,
  maxDelayMs: 5000,
  isRetryable: () => true,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn` with exponential backoff + jitter. Stops early (no further
 * retries) for errors that `isRetryable` marks as permanent.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts = { ...DEFAULTS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === opts.retries;
      if (isLastAttempt || !opts.isRetryable(error)) {
        throw error;
      }
      options.onRetry?.(error, attempt + 1);
      const exponential = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
      const jitter = Math.random() * exponential * 0.25;
      await sleep(exponential + jitter);
    }
  }

  // Unreachable, but keeps TypeScript satisfied.
  throw lastError;
}

/** Wraps fetch with an AbortController-based timeout. */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 4xx (except 408/429) are treated as permanent; 5xx, 408, 429, and network errors are retryable. */
export function isRetryableHttpError(error: unknown): boolean {
  if (error instanceof HttpError) {
    if (error.status === 408 || error.status === 429) return true;
    return error.status >= 500;
  }
  // Network-level errors (fetch throws TypeError/AbortError) are retryable.
  return true;
}
