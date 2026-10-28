import { describe, expect, it } from 'vitest';
import { describeNetworkFailure } from '../../../src/llm/openAiCompatible';
import { AiResponseError } from '../../../src/llm/aiResponseError';
import { classifyRouteFailure, cooldownFor } from '../../../src/llm/aiRouter';

const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code} 127.0.0.1:20128`), { code }) });

describe('network failure description', () => {
  it('names a refused connection instead of a bare TypeError, without leaking the address', () => {
    const text = describeNetworkFailure(fetchFailed('ECONNREFUSED'));
    expect(text).toMatch(/connection refused/);
    expect(text).not.toMatch(/TypeError|127\.0\.0\.1|20128/);
  });

  it('distinguishes DNS, reset, timeout and unknown failures', () => {
    expect(describeNetworkFailure(fetchFailed('ENOTFOUND'))).toMatch(/resolved/);
    expect(describeNetworkFailure(fetchFailed('ECONNRESET'))).toMatch(/reset/);
    expect(describeNetworkFailure(fetchFailed('ETIMEDOUT'))).toBe('timeout');
    expect(describeNetworkFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('timeout');
    expect(describeNetworkFailure(new TypeError('fetch failed'))).toMatch(/network error/);
  });

  it('rests a provider whose address refuses connections far longer than a transient blip, and caps it', () => {
    const refused = new AiResponseError('provider_error', null, 'auto/best-free', describeNetworkFailure(fetchFailed('ECONNREFUSED')));
    refused.network = true;
    const blip = new AiResponseError('provider_error', null, 'm', 'network error (no answer from the provider)');
    blip.network = true;
    expect(classifyRouteFailure(refused)).toBe('network');
    expect(cooldownFor('network', refused, 1).ms).toBe(5 * 60_000);
    expect(cooldownFor('network', refused, 488).ms).toBe(6 * 3_600_000);
    expect(cooldownFor('network', blip, 488).ms).toBe(15 * 60_000);
    expect(cooldownFor('network', refused, 1).scope).toBe('provider');
  });
});
