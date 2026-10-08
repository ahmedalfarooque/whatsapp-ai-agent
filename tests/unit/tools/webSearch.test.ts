import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from '../../../src/config/env';
import { runWithAccount } from '../../../src/accounts/accountContext';
import { setLinkFetcher, setRawHtmlFetcher } from '../../../src/setup/linkFetcher';
import {
  cleanQuery, resolveResultUrl, parseBingResults, webSearchHandler, setWebSearchProvider, resetWebSearchRateLimit, type SearchHit,
} from '../../../src/tools/webSearch';

const wrap = (target: string) => `https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;ptn=3&amp;u=a1${Buffer.from(target).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}&amp;ntb=1`;

const BING_PAGE = `<html><body><ol id="b_results">
<li class="b_algo" data-id iid=SERP.1><div class="b_tpcn"><a class="tilk" href="${wrap('https://www.jotun.com/sa-en/decorative')}"><div>icon</div></a></div><h2><a href="${wrap('https://www.jotun.com/sa-en/decorative')}" h="ID=SERP,1">Decorative Paint | <strong>Jotun</strong> Saudi Arabia</a></h2><div class="b_caption"><p class="b_lineclamp2">Explore Jotun&#39;s range of interior &amp; exterior paints.</p></div></li>
<li class="b_algo" data-id iid=SERP.2><h2><a href="https://example.org/paint-guide">Paint guide</a></h2><p>How to choose paint.</p></li>
<li class="b_algo" data-id iid=SERP.3><h2><a href="javascript:alert(1)">Bad</a></h2><p>x</p></li>
</ol></body></html>`;

const hit = (url: string, title = 'T', snippet = 'S'): SearchHit => ({ title, url, snippet });

describe('web search — query hygiene and result parsing', () => {
  it('removes e-mail addresses and phone numbers from the query, and caps it', () => {
    expect(cleanQuery('Jotun paint for ali@example.com call +966 55 819 0545 please')).toBe('Jotun paint for call please');
    expect(cleanQuery('0558190545')).toBe('');
    expect(cleanQuery('   ')).toBe('');
    expect(cleanQuery(42)).toBe('');
    expect(cleanQuery('x'.repeat(400))).toHaveLength(150);
  });

  it('decodes the real address behind a Bing result link, and refuses anything that is not http(s)', () => {
    expect(resolveResultUrl(wrap('https://www.jotun.com/sa-en/decorative'))).toBe('https://www.jotun.com/sa-en/decorative');
    expect(resolveResultUrl('https://example.org/a')).toBe('https://example.org/a');
    expect(resolveResultUrl('javascript:alert(1)')).toBeNull();
    expect(resolveResultUrl(wrap('file:///etc/passwd'))).toBeNull();
    expect(resolveResultUrl('https://www.bing.com/ck/a?u=zz')).toBeNull();
    expect(resolveResultUrl('not a url')).toBeNull();
  });

  it('parses titles, snippets and real addresses out of a result page', () => {
    const hits = parseBingResults(BING_PAGE);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ title: 'Decorative Paint | Jotun Saudi Arabia', url: 'https://www.jotun.com/sa-en/decorative', snippet: "Explore Jotun's range of interior & exterior paints." });
    expect(hits[1]).toMatchObject({ url: 'https://example.org/paint-guide', title: 'Paint guide' });
    expect(parseBingResults('<html>nothing here</html>')).toEqual([]);
  });
});

describe('web search tool', () => {
  const fetched: string[] = [];

  beforeEach(() => {
    resetWebSearchRateLimit();
    fetched.length = 0;
    setLinkFetcher(async (url) => {
      fetched.push(url);
      return { ok: true, httpStatus: 200, title: 'Page', text: `Title: Page\n\nIntro text.\n\nFenomastic Hygiene Emulsion gives about 12 square metres per litre per coat.\n\nOther unrelated text about shipping.`, error: null, sha256: 'x' };
    });
  });
  afterEach(() => {
    setWebSearchProvider(null);
    setLinkFetcher(null);
    setRawHtmlFetcher(null);
    (env as { WEB_SEARCH_ENABLED: boolean }).WEB_SEARCH_ENABLED = true;
  });

  it('returns results with the most relevant excerpt of the top pages, and a warning that these are not the business records', async () => {
    setWebSearchProvider(async () => [hit('https://www.jotun.com/a', 'Official'), hit('https://example.org/b', 'Guide'), hit('https://example.org/c', 'Third')]);
    const out = (await webSearchHandler({ query: 'Fenomastic Hygiene Emulsion coverage' })) as { results: Array<{ url: string; excerpt?: string }>; note: string };
    expect(out.results.map((r) => r.url)).toEqual(['https://www.jotun.com/a', 'https://example.org/b', 'https://example.org/c']);
    expect(out.results[0]!.excerpt).toContain('12 square metres');
    expect(out.results[2]!.excerpt).toBeUndefined(); // only the top pages are read
    expect(fetched).toEqual(['https://www.jotun.com/a', 'https://example.org/b']);
    expect(out.note).toMatch(/NOT this business/);
  });

  it('sends only the cleaned query to the search provider', async () => {
    const provider = vi.fn(async () => [] as SearchHit[]);
    setWebSearchProvider(provider);
    await webSearchHandler({ query: 'Jotun paint ali@example.com +966558190545' });
    expect(provider).toHaveBeenCalledWith('Jotun paint');
    expect(await webSearchHandler({ query: 'ali@example.com' })).toEqual({ error: 'query is required' });
    expect(await webSearchHandler({})).toEqual({ error: 'query is required' });
  });

  it('never reads private, internal or search-engine addresses', async () => {
    setWebSearchProvider(async () => [
      hit('http://169.254.169.254/latest/meta-data/'),
      hit('http://localhost:3000/api/dashboard'),
      hit('http://10.0.0.5/admin'),
      hit('https://www.bing.com/search?q=x'),
      hit('https://www.google.com/search?q=x'),
      hit('https://www.jotun.com/ok'),
    ]);
    const out = (await webSearchHandler({ query: 'jotun' })) as { results: Array<{ url: string }> };
    expect(out.results.map((r) => r.url)).toEqual(['https://www.jotun.com/ok']);
    expect(fetched).toEqual(['https://www.jotun.com/ok']);
  });

  it('a failing search or an unreadable page degrades gracefully instead of throwing', async () => {
    setWebSearchProvider(async () => { throw new Error('boom'); });
    expect(await webSearchHandler({ query: 'jotun' })).toMatchObject({ results: [], note: expect.stringContaining('temporarily unavailable') });
    setWebSearchProvider(async () => [hit('https://www.jotun.com/a')]);
    setLinkFetcher(async () => { throw new Error('network'); });
    const out = (await webSearchHandler({ query: 'jotun' })) as { results: Array<{ url: string; snippet: string; excerpt?: string }> };
    expect(out.results[0]).toMatchObject({ url: 'https://www.jotun.com/a', snippet: 'S' });
    expect(out.results[0]!.excerpt).toBeUndefined();
    setWebSearchProvider(async () => []);
    expect(await webSearchHandler({ query: 'jotun' })).toMatchObject({ results: [], note: expect.stringContaining('Nothing useful') });
  });

  it('is rate limited per business, and one business using its allowance does not affect another', async () => {
    setWebSearchProvider(async () => []);
    for (let i = 0; i < 12; i += 1) expect(await runWithAccount(2, () => webSearchHandler({ query: `q${i}` }))).not.toHaveProperty('error');
    expect(await runWithAccount(2, () => webSearchHandler({ query: 'one too many' }))).toMatchObject({ error: 'rate_limited' });
    expect(await runWithAccount(1, () => webSearchHandler({ query: 'other business' }))).not.toHaveProperty('error');
  });

  it('WEB_SEARCH_ENABLED=false switches it off', async () => {
    const provider = vi.fn(async () => [] as SearchHit[]);
    setWebSearchProvider(provider);
    (env as { WEB_SEARCH_ENABLED: boolean }).WEB_SEARCH_ENABLED = false;
    expect(await webSearchHandler({ query: 'jotun' })).toMatchObject({ error: 'web_search_disabled' });
    expect(provider).not.toHaveBeenCalled();
  });

  it('without a configured provider, development and test never touch the network', async () => {
    const raw = vi.fn();
    setRawHtmlFetcher(raw);
    expect(await webSearchHandler({ query: 'jotun' })).toMatchObject({ results: [], note: expect.stringContaining('not available') });
    expect(raw).not.toHaveBeenCalled();
  });
});
