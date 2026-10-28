import { describe, expect, it } from 'vitest';
import { GATEWAY_SUMMARY_PREFIX, providerMessageOf, summarizeGatewayFailure } from '../../../src/llm/openAiCompatible';
import { classifyRouteFailure } from '../../../src/llm/aiRouter';
import { AiResponseError } from '../../../src/llm/aiResponseError';
import { describeRouteFailure } from '../../../src/dashboard/aiPoolState';

// Message shape captured from a REAL OmniRoute 3.8.50 502 (auto/best-free with no upstream account connected, 2026-10-28). The fixture is a recorded sample used by a MOCKED unit test:
// it proves the parsing, not that any upstream works.
const REAL_GATEWAY_MESSAGE = 'oc/big-pickle: rate limit — [429]: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go (HTTP 429); '
  + 'oc/muse-spark-1.2-contributor-free: model — [400]: Upstream request failed: Model is unavailable. (HTTP 400); oc/deepseek-v4-flash-free: model — [400]: Upstream request failed: Model is unavailable. (HTTP 400); '
  + 'oc/mimo-v2.5-free: model — [400]: Upstream request failed: Model is unavailable. (HTTP 400); oc/hy3-free: model — [400]: Upstream request failed: Model is unavailable. (HTTP 400)... (+7 more)';

describe('gateway aggregate failures (mocked unit tests on a recorded message)', () => {
  it('summarises a gateway 502 by cause instead of repeating the first upstream', () => {
    expect(summarizeGatewayFailure(REAL_GATEWAY_MESSAGE)).toBe(`${GATEWAY_SUMMARY_PREFIX}: quota/rate-limit ×1, model unavailable ×4 (+7 more)`);
  });

  it('separates a missing upstream key (402) from quota (429) and from timeouts', () => {
    const msg = 'a/x: model — [402]: This model requires an API key — add one in Settings (HTTP 402); b/y: rate limit — [429]: Free usage limit reached (HTTP 429); c/z: model — [504]: upstream timed out (HTTP 504)';
    expect(summarizeGatewayFailure(msg)).toBe(`${GATEWAY_SUMMARY_PREFIX}: quota/rate-limit ×1, needs key ×1, timed out ×1`);
  });

  it('a normal single-provider error is not touched', () => {
    expect(summarizeGatewayFailure('Rate limit exceeded: free-models-per-day')).toBeNull();
    expect(providerMessageOf(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day' } }))).toBe('Rate limit exceeded: free-models-per-day');
  });

  it('providerMessageOf returns the summary for the real body shape, and the summary carries none of the provider text (no key, no URL)', () => {
    const body = JSON.stringify({ error: { message: `${REAL_GATEWAY_MESSAGE} sk-or-v1-abcdefghijklmnop`, type: 'server_error', code: 'bad_gateway' }, diagnostics: {}, recovery_hint: 'x' });
    const message = providerMessageOf(body) as string;
    expect(message.startsWith(GATEWAY_SUMMARY_PREFIX)).toBe(true);
    expect(message).not.toMatch(/sk-|https?:|opencode/i);
    expect(message.length).toBeLessThanOrEqual(120);
  });

  it('the dashboard names it as a gateway problem, not as an unreachable or generic provider', () => {
    const detail = providerMessageOf(JSON.stringify({ error: { message: REAL_GATEWAY_MESSAGE } }));
    const out = describeRouteFailure({ category: 'provider_error', http_status: 502, detail, provider_name: 'OmniRoute', model: 'auto/best-free' });
    expect(out.label).toBe('AI gateway has no working upstream');
    expect(out.detail).toMatch(/none of its upstream providers did \(quota\/rate-limit ×1, model unavailable ×4/);
    expect(out.detail).toMatch(/nothing is purchased/);
  });

  it('an unreachable gateway keeps its own wording and a gateway 502 keeps the bounded provider_error cooldown category', () => {
    expect(describeRouteFailure({ category: 'network', http_status: null, detail: 'connection refused (nothing is listening at the provider address)', provider_name: 'OmniRoute', model: 'auto/best-free' }).detail).toMatch(/connection refused/);
    const error = new AiResponseError('provider_error', 502, 'auto/best-free', providerMessageOf(JSON.stringify({ error: { message: REAL_GATEWAY_MESSAGE } })));
    expect(classifyRouteFailure(error)).toBe('provider_error');
  });
});
