import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { htmlToText } from '../documents/documentStore';
import { logger } from '../logger';

/**
 * Reads the public text of a business link for Analyze & Generate.
 *
 * Safety: the dashboard user supplies the URL, so the fetcher must never be a
 * way to reach internal services. Hosts are checked three ways — the literal
 * host name, the literal IP, and (through a custom DNS lookup used for the
 * actual connection, so there is no check/connect gap) every address the name
 * resolves to. Loopback, private, link-local, CGNAT, multicast and cloud
 * metadata ranges are refused, redirects are followed manually (max 4) and
 * re-validated at every hop, and the body is capped and time-limited.
 *
 * Honesty: only what the server actually returned is used. Login walls
 * (Instagram/Facebook), bot blocks, empty single-page apps and errors become a
 * clear "unavailable" state with the reason — never guessed content.
 */

export interface FetchedPage {
  ok: boolean;
  httpStatus: number | null;
  title: string | null;
  text: string;
  error: string | null;
  sha256: string | null;
}

export type LinkFetcher = (url: string) => Promise<FetchedPage>;

const MAX_BYTES = 1_500_000;
const MAX_TEXT_CHARS = 40_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;
const MIN_USEFUL_TEXT = 40;
const USER_AGENT = 'Mozilla/5.0 (compatible; BusinessSetupBot/1.0; +public-page-reader)';

// ---------------------------------------------------------------- address safety

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inRange(ip: number, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (ipv4ToInt(base) & mask);
}

const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

/** True only for a globally routable unicast address. */
export function isPublicIp(address: string): boolean {
  const kind = net.isIP(address);
  if (kind === 4) {
    const n = ipv4ToInt(address);
    return !BLOCKED_V4.some(([base, bits]) => inRange(n, base, bits));
  }
  if (kind === 6) {
    const a = address.toLowerCase();
    const mapped = /^(?:::ffff:|::ffff:0:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPublicIp(mapped[1]!);
    if (a === '::' || a === '::1') return false;
    if (/^f[cd]/.test(a)) return false; // fc00::/7 unique local
    if (/^fe[89ab]/.test(a)) return false; // fe80::/10 link local
    if (/^ff/.test(a)) return false; // multicast
    if (a.startsWith('2001:db8')) return false; // documentation
    return true;
  }
  return false;
}

export function isForbiddenHostName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (h === 'metadata.google.internal') return true;
  const literal = h.startsWith('[') ? h.slice(1, -1) : h;
  if (net.isIP(literal)) return !isPublicIp(literal);
  return false;
}

/** DNS lookup that refuses non-public answers; used for the real connection so the check cannot be raced. */
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...(typeof options === 'object' ? options : {}), all: true }, (error, addresses) => {
    const list = (addresses ?? []) as dns.LookupAddress[];
    if (error) return (callback as (e: NodeJS.ErrnoException | null, a?: unknown, f?: number) => void)(error);
    const allowed = list.filter((a) => isPublicIp(a.address));
    if (!allowed.length || allowed.length !== list.length) {
      const err = new Error(`${hostname} resolves to a non-public address`) as NodeJS.ErrnoException;
      err.code = 'EBLOCKEDADDR';
      return (callback as (e: NodeJS.ErrnoException | null) => void)(err);
    }
    if (typeof options === 'object' && options.all) return (callback as (e: null, a: dns.LookupAddress[]) => void)(null, allowed);
    return (callback as (e: null, a: string, f: number) => void)(null, allowed[0]!.address, allowed[0]!.family);
  });
};

// ---------------------------------------------------------------- HTTP

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
}

function requestOnce(url: URL, extraHeaders: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      url,
      {
        method: 'GET',
        lookup: guardedLookup,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
          'Accept-Language': 'ar,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          ...extraHeaders,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
        let stream: NodeJS.ReadableStream = res;
        if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        const finish = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated });
        stream.on('end', finish);
        stream.on('close', finish);
        stream.on('error', (e) => (truncated ? finish() : reject(e)));
      },
    );
    req.on('timeout', () => req.destroy(new Error('The site took too long to respond (10 s)')));
    req.on('error', reject);
    req.end();
  });
}

function decodeBody(raw: RawResponse): string {
  const contentType = String(raw.headers['content-type'] ?? '');
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  try {
    return new TextDecoder(charset && ['utf-8', 'utf8', 'iso-8859-1', 'windows-1256', 'windows-1252', 'utf-16le'].includes(charset) ? charset : 'utf-8').decode(raw.body);
  } catch {
    return raw.body.toString('utf8');
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function metaContent(html: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  if (!tag) return null;
  const value = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return value ? decodeEntities(value).trim() : null;
}

/** Title + meta description + visible text of an HTML page. */
export function extractPageText(html: string): { title: string | null; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim() || metaContent(html, 'og:title');
  const description = metaContent(html, 'description') ?? metaContent(html, 'og:description');
  const body = decodeEntities(htmlToText(html.replace(/<(nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')));
  const parts = [title ? `Title: ${title}` : null, description ? `Description: ${description}` : null, body].filter(Boolean) as string[];
  return { title: title || null, text: parts.join('\n').slice(0, MAX_TEXT_CHARS) };
}

const SOCIAL_HINT = /(^|\.)(instagram\.com|facebook\.com|fb\.com|tiktok\.com|linkedin\.com|x\.com|twitter\.com)$/;

function unavailable(httpStatus: number | null, error: string): FetchedPage {
  return { ok: false, httpStatus, title: null, text: '', error, sha256: null };
}

async function defaultFetcher(rawUrl: string): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return unavailable(null, 'This is not a valid link.');
  }
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return unavailable(null, 'Only http and https links can be read.');
      if (isForbiddenHostName(url.hostname)) return unavailable(null, 'This address is private or internal and cannot be read.');
      const response = await requestOnce(url);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (!location) return unavailable(response.status, 'The site redirected without saying where.');
        url = new URL(location, url);
        continue;
      }
      const social = SOCIAL_HINT.test(url.hostname.toLowerCase().replace(/^www\./, ''));
      if (response.status === 401 || response.status === 403 || response.status === 429 || (social && response.status >= 400)) {
        return unavailable(response.status, social ? `${url.hostname} did not return a public page (it usually requires a login). Add the details manually or upload a PDF/screenshot description.` : `The site refused automated access (HTTP ${response.status}).`);
      }
      if (response.status === 404 || response.status === 410) return unavailable(response.status, 'The page was not found (HTTP 404).');
      if (response.status < 200 || response.status >= 300) return unavailable(response.status, `The site answered with HTTP ${response.status}.`);
      const type = String(response.headers['content-type'] ?? '').toLowerCase();
      if (type && !/(text\/html|application\/xhtml|text\/plain)/.test(type)) return unavailable(response.status, `This link is not a web page (${type.split(';')[0]}). Upload it as a document instead.`);
      const body = decodeBody(response);
      const extracted = /text\/plain/.test(type) ? { title: null, text: body.slice(0, MAX_TEXT_CHARS) } : extractPageText(body);
      if (extracted.text.replace(/^(Title|Description): .*$/gm, '').trim().length < MIN_USEFUL_TEXT) {
        return unavailable(response.status, social ? `${url.hostname} returned no public text (login wall or app shell).` : 'The page has no readable text (it may need JavaScript to display its content).');
      }
      return {
        ok: true,
        httpStatus: response.status,
        title: extracted.title,
        text: extracted.text,
        error: null,
        sha256: createHash('sha256').update(extracted.text).digest('hex'),
      };
    }
    return unavailable(null, 'Too many redirects.');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EBLOCKEDADDR') return unavailable(null, 'This address is private or internal and cannot be read.');
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return unavailable(null, 'The site could not be found (DNS lookup failed).');
    if (code === 'ECONNREFUSED' || code === 'ECONNRESET') return unavailable(null, 'The site refused or dropped the connection.');
    if (code === 'CERT_HAS_EXPIRED' || String(code).startsWith('ERR_TLS') || String(code).includes('CERT')) return unavailable(null, 'The site has an invalid or expired security certificate.');
    logger.info({ code, message: (error as Error).message }, 'business link could not be fetched');
    return unavailable(null, (error as Error).message.slice(0, 160) || 'The site could not be reached.');
  }
}

let fetcher: LinkFetcher = defaultFetcher;

/** Tests (and offline development) replace the network. */
export function setLinkFetcher(next: LinkFetcher | null): void {
  fetcher = next ?? defaultFetcher;
}

export async function fetchLinkContent(url: string): Promise<FetchedPage> {
  return fetcher(url);
}

// ---------------------------------------------------------------- raw HTML (web search result pages)

export interface RawHtmlPage {
  ok: boolean;
  httpStatus: number | null;
  finalUrl: string | null;
  html: string;
  error: string | null;
}

export type RawHtmlFetcher = (url: string, headers?: Record<string, string>) => Promise<RawHtmlPage>;

/** Same protections as page reading — public hosts only, DNS answers checked at connect time, redirects followed manually (max 4), size capped — but returns the HTML itself. */
async function defaultRawHtmlFetcher(rawUrl: string, headers: Record<string, string> = {}): Promise<RawHtmlPage> {
  const fail = (httpStatus: number | null, error: string): RawHtmlPage => ({ ok: false, httpStatus, finalUrl: null, html: '', error });
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail(null, 'This is not a valid link.');
  }
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return fail(null, 'Only http and https links can be read.');
      if (isForbiddenHostName(url.hostname)) return fail(null, 'This address is private or internal and cannot be read.');
      const response = await requestOnce(url, headers);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (!location) return fail(response.status, 'The site redirected without saying where.');
        url = new URL(location, url);
        continue;
      }
      if (response.status < 200 || response.status >= 300) return fail(response.status, `The site answered with HTTP ${response.status}.`);
      return { ok: true, httpStatus: response.status, finalUrl: url.toString(), html: decodeBody(response), error: null };
    }
    return fail(null, 'Too many redirects.');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EBLOCKEDADDR') return fail(null, 'This address is private or internal and cannot be read.');
    return fail(null, (error as Error).message.slice(0, 160) || 'The site could not be reached.');
  }
}

let rawFetcher: RawHtmlFetcher = defaultRawHtmlFetcher;

/** Tests replace the network. */
export function setRawHtmlFetcher(next: RawHtmlFetcher | null): void {
  rawFetcher = next ?? defaultRawHtmlFetcher;
}

export async function fetchRawHtml(url: string, headers?: Record<string, string>): Promise<RawHtmlPage> {
  return rawFetcher(url, headers);
}
