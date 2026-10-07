import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import {
  createLink, deleteLink, detectLinkKind, getLink, getLinkText, listLinks, normalizeUrl, recordFetchResult, updateLink, LinkValidationError, MAX_LINKS_PER_ACCOUNT,
} from '../../../src/setup/linksRepo';
import { extractPageText, fetchLinkContent, isForbiddenHostName, isPublicIp, setLinkFetcher } from '../../../src/setup/linkFetcher';

let two: number;

beforeAll(() => {
  getDb();
  two = createAccount({ name: 'Noor Salon', businessCategory: 'Beauty salon' }).id;
});

afterEach(() => setLinkFetcher(null));

describe('link normalisation and categories', () => {
  it('accepts pasted addresses, adds https, drops the fragment and refuses anything unsafe', () => {
    expect(normalizeUrl('example.com/menu')).toBe('https://example.com/menu');
    expect(normalizeUrl('  https://Example.com/a#section ')).toBe('https://example.com/a');
    expect(() => normalizeUrl('')).toThrow(LinkValidationError);
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(/http/);
    expect(() => normalizeUrl('ftp://example.com')).toThrow(/http/);
    expect(() => normalizeUrl('https://user:secret@example.com')).toThrow(/username or password/);
    expect(() => normalizeUrl('https://has space.com')).toThrow(/spaces/);
    expect(() => normalizeUrl('http://intranet')).toThrow(/public website/);
    expect(() => normalizeUrl(42)).toThrow(LinkValidationError);
  });

  it('detects the category from the host', () => {
    expect(detectLinkKind('https://www.instagram.com/noorsalon')).toBe('instagram');
    expect(detectLinkKind('https://facebook.com/noor')).toBe('facebook');
    expect(detectLinkKind('https://maps.app.goo.gl/abc')).toBe('google_maps');
    expect(detectLinkKind('https://www.google.com/maps/place/x')).toBe('google_maps');
    expect(detectLinkKind('https://noor.example')).toBe('website');
    expect(detectLinkKind('https://youtu.be/xyz')).toBe('youtube');
  });
});

describe('links are per account', () => {
  it('adds, edits, categorises and removes links; another account sees none of them', () => {
    const web = createLink({ url: 'noor.example', label: 'Website' }, two);
    expect(web).toMatchObject({ url: 'https://noor.example/', kind: 'website', label: 'Website', status: 'pending' });
    const insta = createLink({ url: 'https://instagram.com/noor' }, two);
    expect(insta.kind).toBe('instagram');
    const other = createLink({ url: 'https://shop.example', kind: 'other', label: 'Shop' }, two);

    expect(listLinks(two).map((l) => l.url)).toEqual(['https://noor.example/', 'https://instagram.com/noor', 'https://shop.example/']);
    expect(listLinks(1)).toEqual([]); // the original business does not see them
    expect(getLink(web.id, 1)).toBeUndefined();
    expect(updateLink(web.id, { label: 'hacked' }, 1)).toBeUndefined();
    expect(deleteLink(web.id, 1)).toBe(false);

    expect(() => createLink({ url: 'https://noor.example/' }, two)).toThrow(/already/);
    expect(() => createLink({ url: 'https://x.example', kind: 'nonsense' }, two)).toThrow(/Category/);

    const edited = updateLink(other.id, { kind: 'menu', label: 'Menu PDF page', url: 'https://shop.example/menu' }, two)!;
    expect(edited).toMatchObject({ kind: 'menu', label: 'Menu PDF page', url: 'https://shop.example/menu', status: 'pending' });
    expect(deleteLink(insta.id, two)).toBe(true);
    expect(listLinks(two)).toHaveLength(2);
  });

  it('caps the number of links per business', () => {
    const three = createAccount({ name: 'Bulk' }).id;
    for (let i = 0; i < MAX_LINKS_PER_ACCOUNT; i += 1) createLink({ url: `https://site${i}.example` }, three);
    expect(() => createLink({ url: 'https://one-too-many.example' }, three)).toThrow(/at most/);
  });

  it('keeps what was read from a page server-side, shows a failure clearly, and resets when the URL changes', () => {
    const link = createLink({ url: 'https://read.example' }, two);
    const ok = recordFetchResult(link.id, { ok: true, httpStatus: 200, error: null, title: 'Read', text: 'Our services: haircut', sha256: 'x' }, two)!;
    expect(ok).toMatchObject({ status: 'ok', httpStatus: 200, title: 'Read', textLength: 21 });
    expect('text' in ok).toBe(false); // never sent to the browser
    expect(getLinkText(link.id, two)).toBe('Our services: haircut');
    expect(getLinkText(link.id, 1)).toBeNull();

    const failed = recordFetchResult(link.id, { ok: false, httpStatus: 403, error: 'The site refused automated access (HTTP 403).', title: null, text: '', sha256: null }, two)!;
    expect(failed).toMatchObject({ status: 'unavailable', httpStatus: 403, error: expect.stringContaining('refused') });
    expect(getLinkText(link.id, two)).toBeNull();

    recordFetchResult(link.id, { ok: true, httpStatus: 200, error: null, title: 't', text: 'abc', sha256: 'y' }, two);
    const moved = updateLink(link.id, { url: 'https://moved.example' }, two)!;
    expect(moved.status).toBe('pending');
    expect(getLinkText(link.id, two)).toBeNull();
  });
});

describe('the fetcher never reaches internal addresses', () => {
  it('classifies addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.4.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) expect(isPublicIp(ip), ip).toBe(true);
    expect(isForbiddenHostName('localhost')).toBe(true);
    expect(isForbiddenHostName('db.internal')).toBe(true);
    expect(isForbiddenHostName('printer.local')).toBe(true);
    expect(isForbiddenHostName('127.0.0.1')).toBe(true);
    expect(isForbiddenHostName('[::1]')).toBe(true);
    expect(isForbiddenHostName('example.com')).toBe(false);
  });

  it('refuses localhost, loopback, the cloud metadata address and non-http schemes without opening a connection', async () => {
    for (const url of ['http://localhost:3000/api', 'http://127.0.0.1:3000/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'file:///etc/passwd']) {
      const page = await fetchLinkContent(url);
      expect(page.ok, url).toBe(false);
      expect(page.error, url).toMatch(/private|internal|http/i);
      expect(page.text).toBe('');
    }
  });

  it('a replaced fetcher drives the flow (what the tests and the dashboard rely on)', async () => {
    setLinkFetcher(async (url) => ({ ok: true, httpStatus: 200, title: 'T', text: `content of ${url}`, error: null, sha256: 'h' }));
    expect((await fetchLinkContent('https://x.example')).text).toBe('content of https://x.example');
  });
});

describe('page text extraction', () => {
  it('keeps the title, description and visible text; drops scripts, styles and navigation', () => {
    const html = `<html><head><title>Noor Salon &amp; Spa</title><meta name="description" content="Hair, nails &amp; care in Jeddah"><style>.a{}</style></head>
      <body><nav>Home | About</nav><script>alert('x')</script><h1>Our Services</h1><ul><li>Haircut - 50 SAR</li><li>Manicure - 80 SAR</li></ul><footer>© 2026</footer></body></html>`;
    const { title, text } = extractPageText(html);
    expect(title).toBe('Noor Salon & Spa');
    expect(text).toContain('Title: Noor Salon & Spa');
    expect(text).toContain('Description: Hair, nails & care in Jeddah');
    expect(text).toContain('Haircut - 50 SAR');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('Home | About');
    expect(text).not.toContain('.a{}');
  });
});
