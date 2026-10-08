import { TOOL_NAMES } from '../config/constants';
import { env } from '../config/env';
import { logger } from '../logger';
import { currentAccountId } from '../accounts/accountContext';
import { fetchLinkContent, fetchRawHtml, isForbiddenHostName } from '../setup/linkFetcher';
import { chunkText } from '../catalogues/catalogueSearch';

/**
 * Lets the assistant look up CURRENT PUBLIC information on the web when the business's own knowledge cannot answer
 * (a product's current details, a public company fact, ...). It never replaces the business's own data: the system prompt
 * keeps prices, stock, opening hours, phone numbers, addresses and offers of THIS business strictly to the published profile.
 *
 * Safety:
 *  - the query is cleaned of e-mail addresses and phone numbers before it leaves the server, and carries nothing else from
 *    the customer's chat or the business's records;
 *  - the search page and every result page are read through the same guarded fetcher as business links: public hosts only,
 *    DNS answers checked when connecting, redirects followed manually, size capped — loopback, private and cloud-metadata
 *    addresses are refused;
 *  - a small per-business rate limit, and WEB_SEARCH_ENABLED=false switches the tool off everywhere.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export type WebSearchProvider = (query: string) => Promise<SearchHit[]>;

const MAX_QUERY_CHARS = 150;
const RESULTS_RETURNED = 4;
const PAGES_READ = 2;
const EXCERPT_CHARS = 900;
const RATE_WINDOW_MS = 5 * 60_000;
const RATE_MAX_PER_WINDOW = 12;

/** Hosts that are search engines / trackers themselves, never an answer. */
const NOT_AN_ANSWER = /(^|\.)(bing\.com|microsoft\.com|msn\.com|google\.[a-z.]+|duckduckgo\.com|yahoo\.com|r\.bing\.com)$/i;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

// ------------------------------------------------------------------ query hygiene

/** Removes anything personal a model might have copied from the chat; returns '' when nothing searchable is left. */
export function cleanQuery(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Control characters (code < 32) become spaces; then e-mail addresses and phone numbers are removed.
  const printable = Array.from(raw, (ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch)).join('');
  return printable
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_CHARS);
}

// ------------------------------------------------------------------ Bing result page parser

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Bing wraps result links as .../ck/a?...&u=a1<base64url of the real address>. Returns the real http(s) address, or null. */
export function resolveResultUrl(href: string): string | null {
  try {
    const url = new URL(decodeEntities(href));
    if (/(^|\.)bing\.com$/i.test(url.hostname)) {
      const encoded = url.searchParams.get('u');
      if (!encoded || !encoded.startsWith('a1')) return null;
      const real = Buffer.from(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const target = new URL(real);
      return target.protocol === 'https:' || target.protocol === 'http:' ? target.toString() : null;
    }
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function parseBingResults(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const heading = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!heading) continue;
    const url = resolveResultUrl(heading[1]!);
    const title = stripTags(heading[2]!);
    if (!url || !title) continue;
    const snippet = stripTags(/<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? '');
    hits.push({ title, url, snippet });
  }
  return hits;
}

async function bingProvider(query: string): Promise<SearchHit[]> {
  const page = await fetchRawHtml(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en&cc=SA`, BROWSER_HEADERS);
  if (!page.ok) throw new Error(page.error ?? 'search page unavailable');
  return parseBingResults(page.html);
}

let provider: WebSearchProvider = bingProvider;

/** Tests (and an alternative search service) replace the search provider. */
export function setWebSearchProvider(next: WebSearchProvider | null): void {
  provider = next ?? bingProvider;
}

// ------------------------------------------------------------------ rate limit

const calls = new Map<number, number[]>();

function allowCall(accountId: number, now = Date.now()): boolean {
  const recent = (calls.get(accountId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX_PER_WINDOW) {
    calls.set(accountId, recent);
    return false;
  }
  recent.push(now);
  calls.set(accountId, recent);
  return true;
}

export function resetWebSearchRateLimit(): void {
  calls.clear();
}

// ------------------------------------------------------------------ excerpts

function bestExcerpt(text: string, query: string): string {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  const body = text.replace(/^(Title|Description): .*$/gm, '').trim();
  const chunks = chunkText(body);
  if (chunks.length === 0) return '';
  let best = chunks[0]!;
  let bestScore = -1;
  for (const chunk of chunks) {
    const lower = chunk.toLowerCase();
    const score = words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = chunk;
      bestScore = score;
    }
  }
  return best.slice(0, EXCERPT_CHARS);
}

// ------------------------------------------------------------------ the tool

export const webSearchSchema = {
  type: 'function' as const,
  function: {
    name: TOOL_NAMES.WEB_SEARCH,
    description:
      "Look up CURRENT PUBLIC information on the web (for example a product's current details, an official company page, a public fact) when the business's own knowledge, documents and catalogues do not answer the question. Never use it for this business's own prices, stock, opening hours, phone, address or offers. Write a short search query without any personal data. Returns a few results with the source address.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up, in a few words — e.g. "Jotun Fenomastic Hygiene Emulsion coverage", "Jotun Saudi Arabia official website".' },
      },
      required: ['query'],
    },
  },
};

export async function webSearchHandler(args: unknown): Promise<unknown> {
  if (!env.WEB_SEARCH_ENABLED) return { error: 'web_search_disabled', note: 'Web search is switched off. Answer from the business information only, or offer a human.' };
  if (provider === bingProvider && env.shouldUseMockProviders) return { results: [], note: 'Web search is not available in this environment.' };
  const query = cleanQuery((args as { query?: unknown })?.query);
  if (!query) return { error: 'query is required' };
  const accountId = currentAccountId();
  if (!allowCall(accountId)) return { error: 'rate_limited', note: 'Too many web searches just now. Answer from the business information, or offer a human.' };

  let hits: SearchHit[];
  try {
    hits = await provider(query);
  } catch (error) {
    logger.warn({ account: accountId, error: (error as Error).message }, 'web search failed');
    return { results: [], note: 'Web search is temporarily unavailable. Say you could not check right now and offer a human.' };
  }

  const seen = new Set<string>();
  const usable: SearchHit[] = [];
  for (const hit of hits) {
    let host: string;
    try {
      host = new URL(hit.url).hostname;
    } catch {
      continue;
    }
    if (isForbiddenHostName(host) || NOT_AN_ANSWER.test(host) || seen.has(hit.url)) continue;
    seen.add(hit.url);
    usable.push(hit);
    if (usable.length >= RESULTS_RETURNED) break;
  }

  const pages = await Promise.all(
    usable.slice(0, PAGES_READ).map(async (hit) => {
      try {
        const page = await fetchLinkContent(hit.url);
        return page.ok ? bestExcerpt(page.text, query) : '';
      } catch {
        return '';
      }
    }),
  );

  logger.info({ account: accountId, results: usable.length }, 'web search answered');
  return {
    results: usable.map((hit, i) => ({ title: hit.title, url: hit.url, snippet: hit.snippet, ...(pages[i] ? { excerpt: pages[i] } : {}) })),
    note: usable.length
      ? "Public web results — NOT this business's records. Use them only for general or current public information, prefer the company's own official website, never present them as this business's prices, stock, hours, phone, address or offers, and say so if they are unclear or disagree. Mention the source site when it helps."
      : 'Nothing useful was found on the web. Say you could not confirm it and offer a human.',
  };
}
