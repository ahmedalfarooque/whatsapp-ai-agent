import { describe, expect, it } from 'vitest';
import { completionFromEventStream, parseCompletionBody, stripKeepAlive, validateCompletion } from '../../../src/llm/openAiCompatible';
import { AiResponseError } from '../../../src/llm/aiResponseError';
import { AiCredentialError } from '../../../src/llm/aiCredentialError';

/** How a provider's HTTP 200 body is read: JSON, JSON behind keep-alive comments, an event stream — and what is never accepted as an answer. */
const answer = { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] };
const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

describe('reading an HTTP 200 body', () => {
  it('plain JSON, JSON after OpenRouter keep-alive comment lines, a BOM and surrounding whitespace all parse', () => {
    expect(parseCompletionBody(JSON.stringify(answer), 'm', 200)).toEqual(answer);
    expect(parseCompletionBody(`: OPENROUTER PROCESSING\n\n: OPENROUTER PROCESSING\n\n${JSON.stringify(answer)}\n`, 'm', 200)).toEqual(answer);
    expect(parseCompletionBody(`${String.fromCharCode(0xfeff)}  \n${JSON.stringify(answer)}`, 'm', 200)).toEqual(answer);
    expect(stripKeepAlive(': a\n: b\n{"x":1}')).toBe('{"x":1}');
  });

  it('an event stream is folded into the one completion it carries (text, reasoning, tool calls, finish reason)', () => {
    const body = `: OPENROUTER PROCESSING\n\n${chunk({ role: 'assistant', content: 'He' })}${chunk({ content: 'llo', reasoning: 'thinking' })}${chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'lookup', arguments: '{"a"' } }] })}${chunk({ tool_calls: [{ index: 0, function: { arguments: ':1}' } }] }, 'tool_calls')}data: [DONE]\n\n`;
    const folded = completionFromEventStream(body) as { choices: Array<{ finish_reason: string; message: { content: string; reasoning: string; tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> } }> };
    expect(folded.choices[0]!.message.content).toBe('Hello');
    expect(folded.choices[0]!.message.reasoning).toBe('thinking');
    expect(folded.choices[0]!.message.tool_calls[0]).toMatchObject({ id: 'c1', function: { name: 'lookup', arguments: '{"a":1}' } });
    expect(folded.choices[0]!.finish_reason).toBe('tool_calls');
    expect(validateCompletion(parseCompletionBody(body, 'm', 200), 'm').choices[0]!.message.content).toBe('Hello');
    expect(completionFromEventStream('no chunks here')).toBeNull();
  });

  it('HTML, plain text and an empty body are malformed answers that say what the body was (kind and size, never its content)', () => {
    for (const [body, kind] of [['<!doctype html><html>secret page</html>', 'html'], ['upstream timed out', 'text'], ['', 'empty'], ['  \n ', 'empty']] as const) {
      let caught: unknown;
      try { parseCompletionBody(body, 'm', 200); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(AiResponseError);
      const e = caught as AiResponseError;
      expect(e.reason).toBe('malformed_response');
      expect(e.httpStatus).toBe(200);
      expect(e.providerMessage).toBe(`the answer body was not JSON (${kind}, ${body.length} bytes)`);
      expect(e.providerMessage).not.toMatch(/secret|timed out/);
    }
  });
});

describe('HTTP 200 alone is not an answer: an error inside the body is a failed inference', () => {
  const attempt = (body: unknown): AiResponseError | AiCredentialError | null => {
    try { validateCompletion(body, 'm'); return null; } catch (e) { return e as AiResponseError | AiCredentialError; }
  };

  it('an error object with no choice keeps the provider\'s own class: rate limit, quota, outage, or a plain provider error', () => {
    expect(attempt({ error: { code: 429, message: 'Rate limit exceeded' } })).toMatchObject({ reason: 'rate_limited', httpStatus: 429 });
    expect(attempt({ error: { code: 402, message: 'Insufficient credits' } })).toMatchObject({ reason: 'payment_required' });
    expect(attempt({ error: { code: 503, message: 'Provider returned error' } })).toMatchObject({ httpStatus: 503 });
    expect(attempt({ error: { message: 'something broke' } })).toMatchObject({ reason: 'provider_error', httpStatus: 200 });
    expect(attempt({ error: 'plain string failure' })).toMatchObject({ reason: 'provider_error', providerMessage: 'plain string failure' });
  });

  it('an embedded 401/403 is a rejected KEY (credential error), not a model problem', () => {
    expect(attempt({ error: { code: 401, message: 'User not found.' } })).toBeInstanceOf(AiCredentialError);
    expect(attempt({ error: { code: 403, message: 'forbidden' } })).toBeInstanceOf(AiCredentialError);
  });

  it('an error that arrives NEXT TO a choice still fails it when the choice is empty or finished with "error" — but never discards a real answer', () => {
    expect(attempt({ error: { code: 502, message: 'upstream failed' }, choices: [{ index: 0, finish_reason: 'error', message: { role: 'assistant', content: 'half an ans' } }] })).toMatchObject({ httpStatus: 502 });
    expect(attempt({ error: { code: 502, message: 'upstream failed' }, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }] })).toMatchObject({ httpStatus: 502 });
    expect(attempt({ error: { code: 200, message: 'note' }, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'a real answer' } }] })).toBeNull();
  });

  it('no choices and no error is malformed (field names only), and an empty message is an empty answer — never a success', () => {
    expect(attempt({ id: 'x', model: 'm' })).toMatchObject({ reason: 'malformed_response', providerMessage: 'no choices in the answer (fields: id, model)' });
    expect(attempt({ choices: [] })).toMatchObject({ reason: 'malformed_response' });
    expect(attempt({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }] })).toMatchObject({ reason: 'empty_response' });
    expect(attempt(answer)).toBeNull();
  });
});
