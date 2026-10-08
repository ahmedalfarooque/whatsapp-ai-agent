import fs from 'node:fs';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { accountHasFeature, FEATURES } from '../accounts/accountFeatures';
import {
  DocumentValidationError, deleteDocument, documentPath, extractDocumentText, getDocument, replaceDocumentFile, saveDocument, updateDocument,
  type BusinessDocument,
} from '../documents/documentStore';
import { extractPdfText } from '../setup/pdfText';

/**
 * The customer-facing PDF catalogues of ONE business.
 *
 * A catalogue is a normal business_documents row (account-scoped folder, hash,
 * extracted text) plus an account_catalogues row with its display title, page
 * count, order and whether customers may be offered it. Every function takes
 * the account explicitly (defaulting to the current one) and every query is
 * filtered by it, so a catalogue id from another business is simply "not found".
 * The whole feature exists only for businesses with the "catalogues" feature.
 */

export const MAX_CATALOGUE_BYTES = 25 * 1024 * 1024;
export const MAX_CATALOGUE_TITLE = 120;

export class CatalogueError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = 'CatalogueError';
  }
}

export interface Catalogue {
  id: number;
  accountId: number;
  documentId: number;
  title: string;
  originalName: string;
  sizeBytes: number;
  pageCount: number | null;
  enabled: boolean;
  sortOrder: number;
  hasText: boolean;
  textLength: number;
  processing: string;
  uploadedAt: string;
  updatedAt: string;
}

interface Row {
  id: number;
  whatsapp_account_id: number;
  document_id: number;
  title: string;
  page_count: number | null;
  sort_order: number;
  enabled: number;
  updated_at: string;
  original_name: string;
  size_bytes: number;
  processing: string;
  text_len: number | null;
  uploaded_at: string;
}

const SELECT = `SELECT c.id, c.whatsapp_account_id, c.document_id, c.title, c.page_count, c.sort_order, c.enabled, c.updated_at,
    d.original_name, d.size_bytes, d.processing, length(d.extracted_text) AS text_len, d.created_at AS uploaded_at
  FROM account_catalogues c
  JOIN business_documents d ON d.id = c.document_id AND d.whatsapp_account_id = c.whatsapp_account_id`;

function toCatalogue(r: Row): Catalogue {
  return {
    id: r.id, accountId: r.whatsapp_account_id, documentId: r.document_id, title: r.title, originalName: r.original_name, sizeBytes: r.size_bytes,
    pageCount: r.page_count, enabled: r.enabled === 1, sortOrder: r.sort_order, hasText: (r.text_len ?? 0) > 0, textLength: r.text_len ?? 0,
    processing: r.processing, uploadedAt: r.uploaded_at, updatedAt: r.updated_at,
  };
}

export function cataloguesEnabledFor(accountId: number = currentAccountId(), db: Database.Database = getDb()): boolean {
  return accountHasFeature(accountId, FEATURES.CATALOGUES, db);
}

function requireFeature(accountId: number, db: Database.Database): void {
  if (!cataloguesEnabledFor(accountId, db)) throw new CatalogueError('The catalogue library is not enabled for this business', 404);
}

// ------------------------------------------------------------------ reads

export function listCatalogues(accountId: number = currentAccountId(), db: Database.Database = getDb()): Catalogue[] {
  if (!cataloguesEnabledFor(accountId, db)) return [];
  return (db.prepare(`${SELECT} WHERE c.whatsapp_account_id = ? ORDER BY c.sort_order, c.id`).all(accountId) as Row[]).map(toCatalogue);
}

export function getCatalogue(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): Catalogue | undefined {
  if (!cataloguesEnabledFor(accountId, db)) return undefined;
  const row = db.prepare(`${SELECT} WHERE c.id = ? AND c.whatsapp_account_id = ?`).get(id, accountId) as Row | undefined;
  return row ? toCatalogue(row) : undefined;
}

/** What a customer may be offered: enabled catalogues whose file is still active, in the owner's order. */
export function customerCatalogues(accountId: number = currentAccountId(), db: Database.Database = getDb()): Catalogue[] {
  if (!cataloguesEnabledFor(accountId, db)) return [];
  const rows = db.prepare(`${SELECT} WHERE c.whatsapp_account_id = ? AND c.enabled = 1 AND d.status = 'active' ORDER BY c.sort_order, c.id`).all(accountId) as Row[];
  return rows.map(toCatalogue);
}

const KEYCAPS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const keycap = (n: number): string => KEYCAPS[n] ?? `${n}.`;

/** The numbered list shown to customers ({catalogues} in the reply templates), generated from the database every time. */
export function renderCustomerCatalogues(_language: 'ar' | 'en' = 'en', accountId: number = currentAccountId(), db: Database.Database = getDb()): string {
  return customerCatalogues(accountId, db).map((c, i) => `${keycap(i + 1)} ${c.title}`).join('\n');
}

export interface DeliverableCatalogue {
  title: string;
  fileName: string;
  mimeType: 'application/pdf';
  path: string;
  sizeBytes: number;
}

function safeFileName(title: string): string {
  // eslint-disable-next-line no-control-regex -- strip C0 control characters and path/shell characters from the file name WhatsApp shows
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Catalogue';
  return `${cleaned}.pdf`;
}

/** The file to send to a customer — only if it belongs to this business, is enabled and its document is active. */
export function getDeliverableCatalogue(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): DeliverableCatalogue | undefined {
  const item = customerCatalogues(accountId, db).find((c) => c.id === id);
  if (!item) return undefined;
  const doc = getDocument(item.documentId, db, accountId);
  if (!doc) return undefined;
  const filePath = documentPath(doc);
  if (!fs.existsSync(filePath)) return undefined;
  return { title: item.title, fileName: safeFileName(item.title), mimeType: 'application/pdf', path: filePath, sizeBytes: doc.size_bytes };
}

// ------------------------------------------------------------------ validation

function cleanTitle(value: unknown): string {
  const t = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!t) throw new CatalogueError('A catalogue needs a title');
  if (t.length > MAX_CATALOGUE_TITLE) throw new CatalogueError(`The title is too long (${MAX_CATALOGUE_TITLE} characters max)`);
  return t;
}

/** "Jotun_Interiour Colors 1.pdf" → "Jotun Interiour Colors 1" — only a starting point the owner can rename. */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (base || 'Catalogue').slice(0, MAX_CATALOGUE_TITLE);
}

interface CheckedPdf {
  pages: number;
}

/** PDF-only intake: extension, MIME type, size, magic bytes and a real parse. Throws CatalogueError. */
async function checkPdf(input: { originalName: string; mimeType: string; bytes: Buffer }): Promise<CheckedPdf> {
  const name = input.originalName.split(/[\\/]/).pop() ?? '';
  if (!/\.pdf$/i.test(name)) throw new CatalogueError('Only PDF files can be added as catalogues (the file name must end in .pdf)');
  const mime = (input.mimeType || '').split(';')[0]!.trim().toLowerCase();
  if (mime !== 'application/pdf') throw new CatalogueError('Only PDF files can be added as catalogues (the file type must be application/pdf)');
  if (input.bytes.length === 0) throw new CatalogueError('The file is empty');
  if (input.bytes.length > MAX_CATALOGUE_BYTES) throw new CatalogueError(`The file is larger than ${MAX_CATALOGUE_BYTES / 1024 / 1024} MB`, 413);
  if (input.bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new CatalogueError('The file content is not a PDF');
  const parsed = await extractPdfText(input.bytes);
  if (!parsed.pages || parsed.pages < 1) throw new CatalogueError('This PDF could not be read — it may be damaged or password-protected');
  return { pages: parsed.pages };
}

function assertNotDuplicate(accountId: number, bytes: Buffer, db: Database.Database, exceptCatalogueId?: number): void {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const row = db.prepare(
    `SELECT c.id, c.title FROM account_catalogues c JOIN business_documents d ON d.id = c.document_id
     WHERE c.whatsapp_account_id = ? AND d.sha256 = ?`,
  ).get(accountId, sha) as { id: number; title: string } | undefined;
  if (row && row.id !== exceptCatalogueId) throw new CatalogueError(`This exact file is already in the library as "${row.title}"`, 409);
}

function nextSortOrder(accountId: number, db: Database.Database): number {
  const row = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM account_catalogues WHERE whatsapp_account_id = ?').get(accountId) as { n: number };
  return row.n;
}

// ------------------------------------------------------------------ writes

export async function uploadCatalogue(
  input: { originalName: string; mimeType: string; bytes: Buffer; title?: string | null; uploadedBy?: string },
  accountId: number = currentAccountId(),
  db: Database.Database = getDb(),
): Promise<Catalogue> {
  requireFeature(accountId, db);
  const title = input.title && input.title.trim() ? cleanTitle(input.title) : titleFromFileName(input.originalName.split(/[\\/]/).pop() ?? '');
  const { pages } = await checkPdf(input);
  assertNotDuplicate(accountId, input.bytes, db);
  let doc: BusinessDocument;
  try {
    doc = saveDocument({
      originalName: input.originalName.split(/[\\/]/).pop() ?? 'catalogue.pdf', mimeType: 'application/pdf', bytes: input.bytes, visibility: 'ai_knowledge',
      title, purpose: 'product_catalogue', uploadedBy: input.uploadedBy, accountId, maxBytes: MAX_CATALOGUE_BYTES,
    }, db);
  } catch (error) {
    if (error instanceof DocumentValidationError) throw new CatalogueError(error.message);
    throw error;
  }
  try {
    await extractDocumentText(doc.id, db, accountId);
    const result = db.prepare('INSERT INTO account_catalogues (whatsapp_account_id, document_id, title, page_count, sort_order) VALUES (?, ?, ?, ?, ?)').run(accountId, doc.id, title, pages, nextSortOrder(accountId, db));
    return getCatalogue(Number(result.lastInsertRowid), accountId, db)!;
  } catch (error) {
    deleteDocument(doc.id, db, accountId); // never leave an orphan file behind
    throw error;
  }
}

/** Adds an already-stored PDF of this business (e.g. one uploaded earlier through the documents page) to the library. */
export async function registerExistingDocument(accountId: number, documentId: number, title: string, db: Database.Database = getDb()): Promise<Catalogue> {
  requireFeature(accountId, db);
  const doc = getDocument(documentId, db, accountId);
  if (!doc) throw new CatalogueError('Document not found for this business', 404);
  if (doc.extension !== 'pdf') throw new CatalogueError('Only PDF documents can be catalogues');
  const existing = db.prepare('SELECT id FROM account_catalogues WHERE document_id = ?').get(documentId) as { id: number } | undefined;
  if (existing) return getCatalogue(existing.id, accountId, db)!;
  const parsed = await extractPdfText(fs.readFileSync(documentPath(doc)));
  if (!parsed.pages) throw new CatalogueError('This PDF could not be read');
  if (doc.processing !== 'text_extracted') await extractDocumentText(documentId, db, accountId);
  updateDocument(documentId, { visibility: 'ai_knowledge', purpose: 'product_catalogue' }, db, accountId);
  const result = db.prepare('INSERT INTO account_catalogues (whatsapp_account_id, document_id, title, page_count, sort_order) VALUES (?, ?, ?, ?, ?)').run(accountId, documentId, cleanTitle(title), parsed.pages, nextSortOrder(accountId, db));
  return getCatalogue(Number(result.lastInsertRowid), accountId, db)!;
}

function mustGet(id: number, accountId: number, db: Database.Database): Catalogue {
  requireFeature(accountId, db);
  const item = getCatalogue(id, accountId, db);
  if (!item) throw new CatalogueError('Catalogue not found', 404);
  return item;
}

export function renameCatalogue(id: number, title: unknown, accountId: number = currentAccountId(), db: Database.Database = getDb()): Catalogue {
  mustGet(id, accountId, db);
  db.prepare("UPDATE account_catalogues SET title = ?, updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ?").run(cleanTitle(title), id, accountId);
  return getCatalogue(id, accountId, db)!;
}

/** Enabled catalogues are offered to customers and searchable by the assistant; disabled ones are neither. */
export function setCatalogueEnabled(id: number, enabled: boolean, accountId: number = currentAccountId(), db: Database.Database = getDb()): Catalogue {
  const item = mustGet(id, accountId, db);
  db.transaction(() => {
    db.prepare("UPDATE account_catalogues SET enabled = ?, updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ?").run(enabled ? 1 : 0, id, accountId);
    updateDocument(item.documentId, { visibility: enabled ? 'ai_knowledge' : 'internal' }, db, accountId);
  })();
  return getCatalogue(id, accountId, db)!;
}

export function reorderCatalogues(orderedIds: number[], accountId: number = currentAccountId(), db: Database.Database = getDb()): Catalogue[] {
  requireFeature(accountId, db);
  const current = listCatalogues(accountId, db).map((c) => c.id);
  const same = orderedIds.length === current.length && new Set(orderedIds).size === current.length && orderedIds.every((i) => current.includes(i));
  if (!same) throw new CatalogueError('The new order must list every catalogue of this business exactly once');
  const update = db.prepare("UPDATE account_catalogues SET sort_order = ?, updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ?");
  db.transaction(() => orderedIds.forEach((cid, index) => update.run(index, cid, accountId)))();
  return listCatalogues(accountId, db);
}

export function moveCatalogue(id: number, direction: 'up' | 'down', accountId: number = currentAccountId(), db: Database.Database = getDb()): Catalogue[] {
  mustGet(id, accountId, db);
  const ids = listCatalogues(accountId, db).map((c) => c.id);
  const at = ids.indexOf(id);
  const to = direction === 'up' ? at - 1 : at + 1;
  if (to < 0 || to >= ids.length) return listCatalogues(accountId, db);
  [ids[at], ids[to]] = [ids[to]!, ids[at]!];
  return reorderCatalogues(ids, accountId, db);
}

export async function replaceCatalogueFile(
  id: number,
  input: { originalName: string; mimeType: string; bytes: Buffer },
  accountId: number = currentAccountId(),
  db: Database.Database = getDb(),
): Promise<Catalogue> {
  const item = mustGet(id, accountId, db);
  const { pages } = await checkPdf(input);
  assertNotDuplicate(accountId, input.bytes, db, id);
  const doc = replaceDocumentFile(item.documentId, { originalName: input.originalName.split(/[\\/]/).pop() ?? 'catalogue.pdf', mimeType: 'application/pdf', bytes: input.bytes, maxBytes: MAX_CATALOGUE_BYTES }, db, accountId);
  if (!doc) throw new CatalogueError('Catalogue file not found', 404);
  await extractDocumentText(item.documentId, db, accountId);
  db.prepare("UPDATE account_catalogues SET page_count = ?, updated_at = datetime('now') WHERE id = ? AND whatsapp_account_id = ?").run(pages, id, accountId);
  return getCatalogue(id, accountId, db)!;
}

/** Removes the catalogue and its file; customers stop seeing it immediately (the list is read live). */
export function deleteCatalogue(id: number, accountId: number = currentAccountId(), db: Database.Database = getDb()): void {
  const item = mustGet(id, accountId, db);
  db.transaction(() => {
    db.prepare('DELETE FROM account_catalogues WHERE id = ? AND whatsapp_account_id = ?').run(id, accountId);
    deleteDocument(item.documentId, db, accountId);
  })();
}
