import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { env } from '../config/env';
import { currentAccountId, LEGACY_ACCOUNT_ID } from '../accounts/accountContext';
import { extractPdfText } from '../setup/pdfText';
import { dataDir } from '../accounts/accountRepo';

/**
 * Business documents (brochures, price lists, presentations, images).
 * Metadata in SQLite, bytes under data/uploads/. Every accepted file passes an
 * extension + MIME allowlist and a size cap; names are never trusted for paths
 * (files are stored under a random name) and HTML is never served executable.
 */

export type DocumentVisibility = 'internal' | 'ai_knowledge' | 'customer';
export type DocumentStatus = 'active' | 'archived';
export type DocumentProcessing = 'stored' | 'text_extracted' | 'extraction_failed' | 'unsupported';

/** What a PDF/document is for ("type" in the setup page) and what an image shows ("purpose"). */
export const DOCUMENT_PURPOSES = ['company_profile', 'service_catalogue', 'product_catalogue', 'price_list', 'menu', 'brochure', 'terms', 'faq', 'promotion', 'logo', 'product_image', 'service_image', 'catalogue_image', 'promo_image', 'menu_image', 'storefront', 'certificate', 'other'] as const;
export type DocumentPurpose = (typeof DOCUMENT_PURPOSES)[number];

export interface BusinessDocument {
  id: number;
  whatsapp_account_id: number;
  original_name: string;
  stored_name: string;
  mime_type: string;
  extension: string;
  size_bytes: number;
  sha256: string;
  title: string | null;
  visibility: DocumentVisibility;
  status: DocumentStatus;
  processing: DocumentProcessing;
  extracted_text: string | null;
  purpose: string | null;
  caption: string | null;
  processing_error: string | null;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** extension -> acceptable MIME types (browsers vary; the first is what we serve). */
export const ALLOWED_TYPES: Record<string, string[]> = {
  pdf: ['application/pdf'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  html: ['text/html'],
  htm: ['text/html'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  webp: ['image/webp'],
  txt: ['text/plain'],
  md: ['text/markdown', 'text/plain'],
};

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);
const TEXT_EXT = new Set(['txt', 'md', 'html', 'htm']);

export class DocumentValidationError extends Error {
  status = 400;
}

/** Root of every upload: the original business keeps <data>/uploads; each other business has its own tree. */
function dataRoot(): string {
  return dataDir();
}

export function uploadsDir(): string {
  // Tests only (in-memory database): one folder per test worker, so test files running in parallel never delete each other's uploads.
  if (env.DATABASE_PATH === ':memory:') return path.join(os.tmpdir(), `whatsapp-ai-agent-test-uploads${process.env.VITEST_WORKER_ID ? `-${process.env.VITEST_WORKER_ID}` : ''}`);
  return path.resolve(path.dirname(env.DATABASE_PATH), 'uploads');
}

/**
 * Where an account's uploaded files live. The original business keeps the
 * historical <data>/uploads; every other business gets <data>/accounts/<id>/uploads,
 * the same tree as its Baileys session, so deleting the business removes both.
 */
export function uploadsDirFor(accountId: number = currentAccountId()): string {
  if (!Number.isInteger(accountId) || accountId <= 0) throw new DocumentValidationError('Invalid account');
  if (accountId === LEGACY_ACCOUNT_ID) return uploadsDir();
  return path.join(dataRoot(), 'accounts', String(accountId), 'uploads');
}

function sniff(bytes: Buffer, ext: string): boolean {
  const head = bytes.subarray(0, 12);
  switch (ext) {
    case 'pdf': return head.subarray(0, 4).toString('latin1') === '%PDF';
    case 'png': return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg':
    case 'jpeg': return head[0] === 0xff && head[1] === 0xd8;
    case 'webp': return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'pptx':
    case 'docx': return head[0] === 0x50 && head[1] === 0x4b; // zip container
    case 'ppt':
    case 'doc': return head[0] === 0xd0 && head[1] === 0xcf; // OLE container
    default: return true; // text types: content is inspected on extraction
  }
}

/** Strips tags/scripts from HTML so only readable text reaches the AI prompt. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function validateDocument(input: { originalName: string; mimeType: string; bytes: Buffer; maxBytes?: number }): { ext: string; mime: string } {
  // eslint-disable-next-line no-control-regex -- strip C0 control characters from client-supplied names
  const safeName = path.basename(input.originalName).replace(/[\u0000-\u001f]/g, '');
  const ext = safeName.includes('.') ? safeName.split('.').pop()!.toLowerCase() : '';
  const allowed = ALLOWED_TYPES[ext];
  if (!allowed) throw new DocumentValidationError(`File type .${ext || '?'} is not allowed. Allowed: ${Object.keys(ALLOWED_TYPES).join(', ')}`);
  const mime = (input.mimeType || '').split(';')[0]!.trim().toLowerCase();
  if (mime && mime !== 'application/octet-stream' && !allowed.includes(mime)) {
    throw new DocumentValidationError(`MIME type ${mime} does not match .${ext}`);
  }
  if (input.bytes.length === 0) throw new DocumentValidationError('File is empty');
  const limit = input.maxBytes ?? MAX_DOCUMENT_BYTES;
  if (input.bytes.length > limit) throw new DocumentValidationError(`File exceeds ${limit / 1024 / 1024} MB`);
  if (!sniff(input.bytes, ext)) throw new DocumentValidationError(`File content does not look like a .${ext} file`);
  return { ext, mime: allowed[0]! };
}

function toDoc(row: BusinessDocument): BusinessDocument {
  return row;
}

export function saveDocument(
  input: { originalName: string; mimeType: string; bytes: Buffer; visibility?: DocumentVisibility; title?: string | null; uploadedBy?: string; accountId?: number; purpose?: string | null; caption?: string | null; maxBytes?: number },
  db: Database.Database = getDb(),
): BusinessDocument {
  const accountId = input.accountId ?? currentAccountId();
  const { ext, mime } = validateDocument(input);
  const visibility: DocumentVisibility = ['internal', 'ai_knowledge', 'customer'].includes(input.visibility ?? '') ? (input.visibility as DocumentVisibility) : 'internal';
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const storedName = `${randomUUID()}.${ext}`;
  const dir = uploadsDirFor(accountId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, storedName), input.bytes);

  let processing: DocumentProcessing = 'unsupported';
  let extracted: string | null = null;
  if (TEXT_EXT.has(ext)) {
    const raw = input.bytes.toString('utf8');
    extracted = (ext === 'html' || ext === 'htm' ? htmlToText(raw) : raw).slice(0, 20_000);
    processing = 'text_extracted';
  } else if (IMAGE_EXT.has(ext) || ext === 'pdf') {
    processing = 'stored'; // PDFs are read by extractDocumentText() right after upload (async)
  }

  const result = db
    .prepare(
      `INSERT INTO business_documents (original_name, stored_name, mime_type, extension, size_bytes, sha256, title, visibility, processing, extracted_text, uploaded_by, whatsapp_account_id, purpose, caption)
       VALUES (@originalName, @storedName, @mime, @ext, @size, @sha256, @title, @visibility, @processing, @extracted, @uploadedBy, @accountId, @purpose, @caption)`,
    )
    .run({
      accountId,
      originalName: path.basename(input.originalName).slice(0, 200),
      storedName,
      mime,
      ext,
      size: input.bytes.length,
      sha256,
      title: input.title?.trim().slice(0, 200) || null,
      visibility,
      processing,
      extracted,
      uploadedBy: input.uploadedBy ?? null,
      purpose: normalizePurpose(input.purpose),
      caption: input.caption?.trim().slice(0, 500) || null,
    });
  return getDocument(Number(result.lastInsertRowid), db, accountId)!;
}

export function normalizePurpose(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase();
  return (DOCUMENT_PURPOSES as readonly string[]).includes(v) ? v : null;
}

/**
 * Reads the text layer of a stored PDF and records the outcome on the row
 * (text_extracted / extraction_failed + a reason). Safe to call again.
 */
export async function extractDocumentText(id: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): Promise<BusinessDocument | undefined> {
  const doc = getDocument(id, db, accountId);
  if (!doc) return undefined;
  if (doc.extension !== 'pdf') return doc;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(documentPath(doc));
  } catch {
    db.prepare("UPDATE business_documents SET processing = 'extraction_failed', processing_error = ?, updated_at = datetime('now') WHERE id = ?").run('The stored file could not be read.', id);
    return getDocument(id, db, accountId);
  }
  const result = await extractPdfText(bytes);
  if (result.ok) {
    db.prepare("UPDATE business_documents SET processing = 'text_extracted', extracted_text = ?, processing_error = NULL, updated_at = datetime('now') WHERE id = ?").run(result.text, id);
  } else {
    db.prepare("UPDATE business_documents SET processing = 'extraction_failed', extracted_text = NULL, processing_error = ?, updated_at = datetime('now') WHERE id = ?").run(result.error, id);
  }
  return getDocument(id, db, accountId);
}

/** Scoped to the account: a document id from another business is "not found". */
export function getDocument(id: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): BusinessDocument | undefined {
  const row = db.prepare('SELECT * FROM business_documents WHERE id = ? AND whatsapp_account_id = ?').get(id, accountId) as BusinessDocument | undefined;
  return row ? toDoc(row) : undefined;
}

export function listDocuments(params: { status?: DocumentStatus; visibility?: DocumentVisibility; accountId?: number; kind?: 'document' | 'image' } = {}, db: Database.Database = getDb()): BusinessDocument[] {
  const where: string[] = ['whatsapp_account_id = @accountId'];
  if (params.kind === 'image') where.push("extension IN ('png','jpg','jpeg','webp')");
  if (params.kind === 'document') where.push("extension NOT IN ('png','jpg','jpeg','webp')");
  if (params.status) where.push('status = @status');
  if (params.visibility) where.push('visibility = @visibility');
  return (db
    .prepare(`SELECT * FROM business_documents WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC`)
    .all({ status: params.status, visibility: params.visibility, accountId: params.accountId ?? currentAccountId() }) as BusinessDocument[]).map(toDoc);
}

export function updateDocument(
  id: number,
  patch: { title?: string | null; visibility?: DocumentVisibility; status?: DocumentStatus; purpose?: string | null; caption?: string | null },
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): BusinessDocument | undefined {
  const current = getDocument(id, db, accountId);
  if (!current) return undefined;
  if (patch.visibility && !['internal', 'ai_knowledge', 'customer'].includes(patch.visibility)) throw new DocumentValidationError('Invalid visibility');
  if (patch.status && !['active', 'archived'].includes(patch.status)) throw new DocumentValidationError('Invalid status');
  db.prepare(
    `UPDATE business_documents SET title = @title, visibility = @visibility, status = @status, purpose = @purpose, caption = @caption, updated_at = datetime('now') WHERE id = @id AND whatsapp_account_id = @accountId`,
  ).run({
    id,
    accountId,
    purpose: patch.purpose === undefined ? current.purpose : normalizePurpose(patch.purpose),
    caption: patch.caption === undefined ? current.caption : patch.caption?.trim().slice(0, 500) || null,
    title: patch.title === undefined ? current.title : patch.title?.trim().slice(0, 200) || null,
    visibility: patch.visibility ?? current.visibility,
    status: patch.status ?? current.status,
  });
  return getDocument(id, db, accountId);
}

/** Replaces the bytes of an existing document (same id, new file). */
export function replaceDocumentFile(
  id: number,
  input: { originalName: string; mimeType: string; bytes: Buffer; maxBytes?: number },
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): BusinessDocument | undefined {
  const current = getDocument(id, db, accountId);
  if (!current) return undefined;
  const fresh = saveDocument({ ...input, visibility: current.visibility, title: current.title, accountId }, db);
  // Drop the temporary row first (stored_name is UNIQUE), then move its file under the old id.
  db.prepare('DELETE FROM business_documents WHERE id = ?').run(fresh.id);
  db.prepare(
    `UPDATE business_documents SET original_name = @original_name, stored_name = @stored_name, mime_type = @mime_type, extension = @extension,
       size_bytes = @size_bytes, sha256 = @sha256, processing = @processing, extracted_text = @extracted_text, processing_error = NULL, updated_at = datetime('now') WHERE id = @id AND whatsapp_account_id = @whatsapp_account_id`,
  ).run({ ...fresh, id });
  try { fs.unlinkSync(documentPath(current)); } catch { /* already gone */ }
  return getDocument(id, db, accountId);
}

export function deleteDocument(id: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): boolean {
  const current = getDocument(id, db, accountId);
  if (!current) return false;
  db.prepare('DELETE FROM business_documents WHERE id = ? AND whatsapp_account_id = ?').run(id, accountId);
  try { fs.unlinkSync(documentPath(current)); } catch { /* already gone */ }
  return true;
}

/** Absolute path of the stored bytes — always inside uploadsDir() (stored_name is a UUID we generated). */
export function documentPath(doc: BusinessDocument): string {
  const dir = path.resolve(uploadsDirFor(doc.whatsapp_account_id));
  const resolved = path.resolve(dir, path.basename(doc.stored_name));
  if (!resolved.startsWith(dir + path.sep)) throw new DocumentValidationError('Invalid document path');
  if (doc.whatsapp_account_id !== LEGACY_ACCOUNT_ID && !fs.existsSync(resolved)) {
    // Files uploaded before per-account folders existed (random UUID names) still sit in the shared folder;
    // the database row — which is account-scoped — is what ties them to this business.
    const sharedDir = path.resolve(uploadsDir());
    const legacy = path.resolve(sharedDir, path.basename(doc.stored_name));
    if (legacy.startsWith(sharedDir + path.sep) && fs.existsSync(legacy)) return legacy;
  }
  return resolved;
}

/** Content type to SERVE: HTML is downgraded to text/plain so uploaded scripts can never execute. */
export function serveContentType(doc: BusinessDocument): string {
  if (doc.extension === 'html' || doc.extension === 'htm') return 'text/plain; charset=utf-8';
  if (doc.extension === 'md' || doc.extension === 'txt') return 'text/plain; charset=utf-8';
  return doc.mime_type;
}

/** Text the AI may use: active documents marked ai_knowledge or customer with extracted text. */
export function documentsForAiContext(db: Database.Database = getDb(), accountId: number = currentAccountId()): { title: string; text: string; customerVisible: boolean }[] {
  // Catalogue PDFs are large and are answered from through the search tool (src/catalogues), not pasted into every prompt.
  let catalogueDocs = new Set<number>();
  try {
    catalogueDocs = new Set((db.prepare('SELECT document_id FROM account_catalogues WHERE whatsapp_account_id = ?').all(accountId) as { document_id: number }[]).map((r) => r.document_id));
  } catch {
    /* older databases have no catalogue table */
  }
  return listDocuments({ status: 'active', accountId }, db)
    .filter((d) => !catalogueDocs.has(d.id))
    .filter((d) => (d.visibility === 'ai_knowledge' || d.visibility === 'customer') && d.extracted_text)
    .map((d) => ({ title: d.title || d.original_name, text: d.extracted_text!.slice(0, 4000), customerVisible: d.visibility === 'customer' }));
}

/** Titles of documents customers may be told about (never internal ones). */
export function customerVisibleDocuments(db: Database.Database = getDb(), accountId: number = currentAccountId()): BusinessDocument[] {
  return listDocuments({ status: 'active', visibility: 'customer', accountId }, db);
}
