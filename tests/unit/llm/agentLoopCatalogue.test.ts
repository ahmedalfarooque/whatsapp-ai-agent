import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../../../src/llm/openRouterClient', () => ({ chatCompletion: vi.fn() }));
vi.mock('../../../src/tools/bookAppointment', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/tools/bookAppointment')>();
  return { ...real, bookAppointmentHandler: vi.fn(async () => ({ success: true })) };
});

import { chatCompletion } from '../../../src/llm/openRouterClient';
import { bookAppointmentHandler } from '../../../src/tools/bookAppointment';
import { runAgentLoop } from '../../../src/llm/agentLoop';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { setAccountFeature, FEATURES } from '../../../src/accounts/accountFeatures';
import { uploadCatalogue } from '../../../src/catalogues/catalogueRepo';
import { makePdf } from '../../fixtures/makePdf';

const toolCall = (name: string, args: Record<string, unknown>) => ({
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});
const text = (content: string) => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });

const JOTUN = 2;
const PLAIN = 3;

beforeAll(async () => {
  getDb();
  expect(createAccount({ name: 'JOTUN Test' }).id).toBe(JOTUN);
  expect(createAccount({ name: 'Plain Business' }).id).toBe(PLAIN);
  setAccountFeature(JOTUN, FEATURES.CATALOGUES, true);
  await uploadCatalogue({ originalName: 'c.pdf', mimeType: 'application/pdf', bytes: makePdf(['Jotun Soulful Spaces', '1625 Soul warm neutral colour']), title: 'Jotun Soulful Spaces' }, JOTUN);
});

beforeEach(() => vi.clearAllMocks());

/** Runs one tool call requested by the model and returns what the model was told. */
async function toolResultFor(accountId: number, name: string, args: Record<string, unknown>): Promise<unknown> {
  vi.mocked(chatCompletion).mockResolvedValueOnce(toolCall(name, args) as never).mockResolvedValueOnce(text('done') as never);
  const run = await runWithAccount(accountId, () => runAgentLoop({ systemPrompt: 'sys', history: [], conversationId: 1 }));
  const tool = run.generatedMessages.find((m) => m.role === 'tool');
  return tool ? JSON.parse(tool.content) : undefined;
}

describe('agent loop tool permissions', () => {
  it('a business with the catalogue library can search its catalogues', async () => {
    const result = (await toolResultFor(JOTUN, 'search_catalogues', { query: '1625 Soul' })) as { results: Array<{ source: string; title: string }> };
    expect(result.results[0]).toMatchObject({ source: 'catalogue', title: 'Jotun Soulful Spaces' });
  });

  it('being offered the search tool does NOT unlock the calendar tools (they are refused and never run)', async () => {
    const result = await toolResultFor(JOTUN, 'book_appointment', { service: 'x', startISO: '2030-01-01T10:00:00Z' });
    expect(result).toEqual({ error: 'unknown tool: book_appointment' });
    expect(bookAppointmentHandler).not.toHaveBeenCalled();
    expect(await toolResultFor(JOTUN, 'check_availability', { date: '2030-01-01' })).toEqual({ error: 'unknown tool: check_availability' });
  });

  it('a business without the library cannot call the catalogue search either', async () => {
    expect(await toolResultFor(PLAIN, 'search_catalogues', { query: 'Soul' })).toEqual({ error: 'unknown tool: search_catalogues' });
  });

  it('the original business keeps its calendar tools and cannot call the catalogue search', async () => {
    expect(await toolResultFor(1, 'search_catalogues', { query: 'Soul' })).toEqual({ error: 'unknown tool: search_catalogues' });
    const booked = await toolResultFor(1, 'book_appointment', { service: 'x' });
    expect(booked).toEqual({ success: true });
    expect(bookAppointmentHandler).toHaveBeenCalledTimes(1);
  });

  it('only the tools a business is offered are sent to the model', async () => {
    vi.mocked(chatCompletion).mockResolvedValue(text('hi') as never);
    const names = async (account: number) => {
      vi.mocked(chatCompletion).mockClear();
      await runWithAccount(account, () => runAgentLoop({ systemPrompt: 's', history: [], conversationId: 1 }));
      const tools = vi.mocked(chatCompletion).mock.calls[0]![0].tools as Array<{ function: { name: string } }> | undefined;
      return (tools ?? []).map((t) => t.function.name);
    };
    // Every business may look up current public information; only the others' own tools stay separate.
    expect(await names(JOTUN)).toEqual(['search_catalogues', 'web_search']);
    expect(await names(PLAIN)).toEqual(['web_search']);
    expect(await names(1)).toEqual(['check_availability', 'book_appointment', 'web_search']);
  });

  it('web search runs for any business, returns only public results, and does not unlock the calendar or the catalogues', async () => {
    const { setWebSearchProvider, resetWebSearchRateLimit } = await import('../../../src/tools/webSearch');
    const { setLinkFetcher } = await import('../../../src/setup/linkFetcher');
    resetWebSearchRateLimit();
    setWebSearchProvider(async () => [{ title: 'Official', url: 'https://www.jotun.com/sa-en/decorative', snippet: 'Decorative paints' }]);
    setLinkFetcher(async () => ({ ok: true, httpStatus: 200, title: 'P', text: 'Decorative paints for Saudi homes.', error: null, sha256: 'x' }));
    try {
      for (const account of [PLAIN, JOTUN, 1]) {
        const result = (await toolResultFor(account, 'web_search', { query: 'Jotun decorative paint Saudi' })) as { results: Array<{ url: string }> };
        expect(result.results[0]!.url).toBe('https://www.jotun.com/sa-en/decorative');
      }
      // The plain business is offered web search only: the catalogue search and the calendar stay refused.
      expect(await toolResultFor(PLAIN, 'search_catalogues', { query: 'x' })).toEqual({ error: 'unknown tool: search_catalogues' });
      expect(await toolResultFor(PLAIN, 'book_appointment', { service: 'x' })).toEqual({ error: 'unknown tool: book_appointment' });
    } finally {
      setWebSearchProvider(null);
      setLinkFetcher(null);
    }
  });

  it('with web search switched off, a business without other tools is offered none', async () => {
    const { env } = await import('../../../src/config/env');
    (env as { WEB_SEARCH_ENABLED: boolean }).WEB_SEARCH_ENABLED = false;
    try {
      expect(await toolResultFor(PLAIN, 'web_search', { query: 'x' })).toEqual({ error: 'unknown tool: web_search' });
    } finally {
      (env as { WEB_SEARCH_ENABLED: boolean }).WEB_SEARCH_ENABLED = true;
    }
  });
});
