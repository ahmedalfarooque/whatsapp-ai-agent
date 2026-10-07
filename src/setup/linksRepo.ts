import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';

/**
 * Business links: any number of public URLs per WhatsApp account (website,
 * Instagram, Facebook, Google Maps, menu, other…). Each link carries its own
 * fetch status so "this page could not be read" is always visible; the page
 * text that was read is stored for Analyze & Generate but never listed to the
 * browser in bulk.
 */

export const LINK_KINDS = ['website', 'instagram', 'facebook', 'tiktok', 'linkedin', 'youtube', 'google_maps', 'menu', 'other'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
export type LinkStatus = 'pending' | 'ok' | 'unavailable';
export const MAX_LINKS_PER_ACCOUNT = 30;

export interface BusinessLink {
  id: number;
  accountId: number;
  kind: LinkKind;
  label: string | null;
  url: string;
  status: LinkStatus;
  httpStatus: number | null;
  error: string | null;
  title: string | null;
  /** Characters of page text on file (the text itself is not sent to the browser). */
  textLength: number;
  fetchedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: number;
  whatsapp_account_id: number;
  kind: string;
  label: string | null;
  url: string;
  status: string;
  http_status: number | null;
  error: string | null;
  title: string | null;
  content_text: string | null;
  fetched_at: string | null;
  created_at: string;
  updated_at: string;
}

export class LinkValidationError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
  }
}

function toLink(r: Row): BusinessLink {
  return {
    id: r.id,
    accountId: r.whatsapp_account_id,
    kind: (LINK_KINDS as readonly string[]).includes(r.kind) ? (r.kind as LinkKind) : 'other',
    label: r.label,
    url: r.url,
    status: r.status as LinkStatus,
    httpStatus: r.http_status,
    error: r.error,
    title: r.title,
    textLength: r.content_text ? r.content_text.length : 0,
    fetchedAt: r.fetched_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Guesses the kind from the host so pasting a URL is enough. */
export function detectLinkKind(url: string): LinkKind {
  let host = '';
  let pathName = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, '');
    pathName = u.pathname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host === 'instagram.com' || host.endsWith('.instagram.com') || host === 'instagr.am') return 'instagram';
  if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.com' || host === 'fb.me' || host === 'm.me') return 'facebook';
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
  if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin';
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
  if (host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'share.google' || /^maps\.google\./.test(host) || (/^google\./.test(host) && pathName.startsWith('/maps'))) return 'google_maps';
  return 'website';
}

/**
 * Accepts what people paste ("example.com/menu", "https://…") and returns a
 * canonical http(s) URL. Rejects other schemes, embedded credentials and
 * anything that is not a plausible public host (the fetcher re-checks the
 * addresses the name resolves to).
 */
export function normalizeUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new LinkValidationError('A link is required');
  let value = raw.trim();
  if (!value) throw new LinkValidationError('A link is required');
  if (value.length > 500) throw new LinkValidationError('Link is too long (500 characters max)');
  if (/\s/.test(value)) throw new LinkValidationError('A link cannot contain spaces');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^/]*\.[^/]*$/.test(value.split(':')[0] ?? '')) {
      throw new LinkValidationError('Only http and https links are supported');
    }
    value = `https://${value}`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LinkValidationError('That does not look like a valid link');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new LinkValidationError('Only http and https links are supported');
  if (url.username || url.password) throw new LinkValidationError('Links must not contain a username or password');
  const host = url.hostname.toLowerCase();
  if (!host || (!host.includes('.') && !host.includes(':'))) throw new LinkValidationError('That does not look like a public website address');
  url.hash = '';
  return url.toString();
}

function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().slice(0, 100);
  return t || null;
}

function cleanKind(raw: unknown, url: string): LinkKind {
  if (raw === undefined || raw === null || raw === '' || raw === 'auto') return detectLinkKind(url);
  if (typeof raw === 'string' && (LINK_KINDS as readonly string[]).includes(raw)) return raw as LinkKind;
  throw new LinkValidationError(`Category must be one of: ${LINK_KINDS.join(', ')}`);
}

export function listLinks(accountId: number = currentAccountId(), db: Database.Database = getDb()): BusinessLink[] {
  return (db.prepare('SELECT * FROM business_links WHERE whatsapp_account_id = ? ORDER BY id ASC').all(accountId) as Row[]).map(toLink);
}

export function getLink(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): BusinessLink | undefined {
  const row = db.prepare('SELECT * FROM business_links WHERE id = ? AND whatsapp_account_id = ?').get(id, accountId) as Row | undefined;
  return row ? toLink(row) : undefined;
}

/** The page text read from a link — server-side only, scoped to the account. */
export function getLinkText(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): string | null {
  const row = db.prepare('SELECT content_text FROM business_links WHERE id = ? AND whatsapp_account_id = ?').get(id, accountId) as { content_text: string | null } | undefined;
  return row?.content_text ?? null;
}

export function createLink(input: { url: unknown; kind?: unknown; label?: unknown }, accountId: number = currentAccountId(), db: Database.Database = getDb()): BusinessLink {
  const url = normalizeUrl(input.url);
  const kind = cleanKind(input.kind, url);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM business_links WHERE whatsapp_account_id = ?').get(accountId) as { n: number }).n;
  if (count >= MAX_LINKS_PER_ACCOUNT) throw new LinkValidationError(`A business can have at most ${MAX_LINKS_PER_ACCOUNT} links`);
  const existing = db.prepare('SELECT id FROM business_links WHERE whatsapp_account_id = ? AND url = ?').get(accountId, url);
  if (existing) throw new LinkValidationError('This link is already in the list');
  const result = db
    .prepare('INSERT INTO business_links (whatsapp_account_id, kind, label, url) VALUES (?, ?, ?, ?)')
    .run(accountId, kind, cleanLabel(input.label), url);
  return getLink(Number(result.lastInsertRowid), accountId, db)!;
}

export function updateLink(id: number, patch: { url?: unknown; kind?: unknown; label?: unknown }, accountId: number = currentAccountId(), db: Database.Database = getDb()): BusinessLink | undefined {
  const current = getLink(id, accountId, db);
  if (!current) return undefined;
  const url = patch.url === undefined ? current.url : normalizeUrl(patch.url);
  const urlChanged = url !== current.url;
  if (urlChanged) {
    const clash = db.prepare('SELECT id FROM business_links WHERE whatsapp_account_id = ? AND url = ? AND id <> ?').get(accountId, url, id);
    if (clash) throw new LinkValidationError('This link is already in the list');
  }
  const kind = patch.kind === undefined ? current.kind : cleanKind(patch.kind, url);
  const label = patch.label === undefined ? current.label : cleanLabel(patch.label);
  // A changed URL invalidates whatever was read from the old one.
  db.prepare(
    `UPDATE business_links SET url = @url, kind = @kind, label = @label, updated_at = datetime('now'),
       status = CASE WHEN @urlChanged = 1 THEN 'pending' ELSE status END,
       http_status = CASE WHEN @urlChanged = 1 THEN NULL ELSE http_status END,
       error = CASE WHEN @urlChanged = 1 THEN NULL ELSE error END,
       title = CASE WHEN @urlChanged = 1 THEN NULL ELSE title END,
       content_text = CASE WHEN @urlChanged = 1 THEN NULL ELSE content_text END,
       content_sha256 = CASE WHEN @urlChanged = 1 THEN NULL ELSE content_sha256 END,
       fetched_at = CASE WHEN @urlChanged = 1 THEN NULL ELSE fetched_at END
     WHERE id = @id AND whatsapp_account_id = @accountId`,
  ).run({ id, accountId, url, kind, label, urlChanged: urlChanged ? 1 : 0 });
  return getLink(id, accountId, db);
}

export function deleteLink(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): boolean {
  return db.prepare('DELETE FROM business_links WHERE id = ? AND whatsapp_account_id = ?').run(id, accountId).changes > 0;
}

export function recordFetchResult(
  id: number,
  result: { ok: boolean; httpStatus: number | null; error: string | null; title: string | null; text: string; sha256: string | null },
  accountId: number = currentAccountId(),
  db: Database.Database = getDb(),
): BusinessLink | undefined {
  db.prepare(
    `UPDATE business_links SET status = @status, http_status = @httpStatus, error = @error, title = @title,
       content_text = @text, content_sha256 = @sha256, fetched_at = datetime('now'), updated_at = datetime('now')
     WHERE id = @id AND whatsapp_account_id = @accountId`,
  ).run({
    id,
    accountId,
    status: result.ok ? 'ok' : 'unavailable',
    httpStatus: result.httpStatus,
    error: result.ok ? null : result.error,
    title: result.title,
    text: result.ok ? result.text : null,
    sha256: result.sha256,
  });
  return getLink(id, accountId, db);
}
