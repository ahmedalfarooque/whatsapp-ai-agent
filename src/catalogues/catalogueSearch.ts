import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { getDocument } from '../documents/documentStore';
import { listLinks, getLinkText } from '../setup/linksRepo';
import { cataloguesEnabledFor, customerCatalogues } from './catalogueRepo';

/**
 * Account-scoped retrieval over the text of a business's ENABLED catalogues and of the web pages its
 * administrator linked (e.g. the official Jotun Saudi site). The assistant calls this instead of having
 * whole catalogues pasted into every prompt, so it answers from the relevant passages only.
 */

export interface SearchHit {
  source: 'catalogue' | 'website';
  title: string;
  excerpt: string;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'is', 'are', 'do', 'does', 'you', 'your', 'have', 'has', 'what', 'which', 'with', 'me', 'my', 'i', 'it', 'this', 'that', 'can', 'any', 'about', 'من', 'في', 'على', 'هل', 'ما', 'هي', 'هو', 'عن', 'الى', 'إلى', 'لي', 'أريد', 'اريد']);
const CHUNK = 700;
const OVERLAP = 120;

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => (t.length >= 2 || /\d/.test(t)) && !STOP.has(t));
}

export function chunkText(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += CHUNK - OVERLAP) {
    out.push(clean.slice(i, i + CHUNK));
    if (i + CHUNK >= clean.length) break;
  }
  return out;
}

function score(chunk: string, query: string[], phrase: string): number {
  const lower = chunk.toLowerCase();
  const set = new Set(tokens(chunk));
  let s = 0;
  for (const t of query) if (set.has(t)) s += /\d{3,}/.test(t) ? 4 : 1 + Math.min(2, t.length / 6); // colour codes weigh most
  if (phrase.length > 4 && lower.includes(phrase)) s += 3;
  return s;
}

export function searchSources(query: string, limit = 4, accountId: number = currentAccountId(), db: Database.Database = getDb()): SearchHit[] {
  if (!cataloguesEnabledFor(accountId, db)) return [];
  const q = tokens(query);
  if (!q.length) return [];
  const phrase = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const scored: { hit: SearchHit; score: number }[] = [];

  for (const c of customerCatalogues(accountId, db)) {
    const text = getDocument(c.documentId, db, accountId)?.extracted_text;
    if (!text) continue;
    for (const chunk of chunkText(text)) {
      const sc = score(chunk, q, phrase);
      if (sc > 0) scored.push({ score: sc, hit: { source: 'catalogue', title: c.title, excerpt: chunk } });
    }
  }
  for (const link of listLinks(accountId)) {
    if (link.status !== 'ok') continue;
    const text = getLinkText(link.id, accountId, db);
    if (!text) continue;
    for (const chunk of chunkText(text)) {
      const sc = score(chunk, q, phrase) * 1.15; // the current official website outranks an older catalogue on equal evidence
      if (sc > 0) scored.push({ score: sc, hit: { source: 'website', title: link.label || link.title || link.url, excerpt: chunk } });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const { hit } of scored) {
    const key = `${hit.title}|${hit.excerpt.slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
    if (hits.length >= limit) break;
  }
  return hits;
}
