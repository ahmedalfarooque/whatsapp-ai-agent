import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { env } from '../config/env';

/**
 * Business documents (brochures, price lists, presentations, images).
 * Metadata in SQLite, bytes under data/uploads/. Every accepted file passes an
 * extension + MIME allowlist and a size cap; names are never trusted for paths
 * (files are stored under a random name) and HTML is never served executable.
 */

export type DocumentVisibility = 'internal' | 'ai_knowledge' | 'customer';
export type DocumentStatus = 'active' | 'archived';
export type DocumentProcessing = 'stored' | 'text_extracted' | 'unsupported';

export interface BusinessDocument {
  id: number;
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

export function uploadsDir(): string {
  if (env.DATABASE_PATH === ':memory:') return path.join(os.tmpdir(), 'whatsapp-ai-agent-test-uploads');
  return path.resolve(path.dirname(env.DATABASE_PATH), 'uploads');
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

export function validateDocument(input: { originalName: string; mimeType: string; bytes: Buffer }): { ext: string; mime: string } {
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
  if (input.bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentValidationError(`File exceeds ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`);
  if (!sniff(input.bytes, ext)) throw new DocumentValidationError(`File content does not look like a .${ext} file`);
  return { ext, mime: allowed[0]! };
}

function toDoc(row: BusinessDocument): BusinessDocument {
  return row;
}

export function saveDocument(
  input: { originalName: string; mimeType: string; bytes: Buffer; visibility?: DocumentVisibility; title?: string | null; uploadedBy?: string },
  db: Database.Database = getDb(),
): BusinessDocument {
  const { ext, mime } = validateDocument(input);
  const visibility: DocumentVisibility = ['internal', 'ai_knowledge', 'customer'].includes(input.visibility ?? '') ? (input.visibility as DocumentVisibility) : 'internal';
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  const storedName = `${randomUUID()}.${ext}`;
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, storedName), input.bytes);

  let processing: DocumentProcessing = 'unsupported';
  let extracted: string | null = null;
  if (TEXT_EXT.has(ext)) {
    const raw = input.bytes.toString('utf8');
    extracted = (ext === 'html' || ext === 'htm' ? htmlToText(raw) : raw).slice(0, 20_000);
    processing = 'text_extracted';
  } else if (IMAGE_EXT.has(ext)) {
    processing = 'stored';
  }

  const result = db
    .prepare(
      `INSERT INTO business_documents (original_name, stored_name, mime_type, extension, size_bytes, sha256, title, visibility, processing, extracted_text, uploaded_by)
       VALUES (@originalName, @storedName, @mime, @ext, @size, @sha256, @title, @visibility, @processing, @extracted, @uploadedBy)`,
    )
    .run({
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
    });
  return getDocument(Number(result.lastInsertRowid), db)!;
}

export function getDocument(id: number, db: Database.Database = getDb()): BusinessDocument | undefined {
  const row = db.prepare('SELECT * FROM business_documents WHERE id = ?').get(id) as BusinessDocument | undefined;
  return row ? toDoc(row) : undefined;
}

export function listDocuments(params: { status?: DocumentStatus; visibility?: DocumentVisibility } = {}, db: Database.Database = getDb()): BusinessDocument[] {
  const where: string[] = [];
  if (params.status) where.push('status = @status');
  if (params.visibility) where.push('visibility = @visibility');
  return (db
    .prepare(`SELECT * FROM business_documents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC`)
    .all(params) as BusinessDocument[]).map(toDoc);
}

export function updateDocument(
  id: number,
  patch: { title?: string | null; visibility?: DocumentVisibility; status?: DocumentStatus },
  db: Database.Database = getDb(),
): BusinessDocument | undefined {
  const current = getDocument(id, db);
  if (!current) return undefined;
  if (patch.visibility && !['internal', 'ai_knowledge', 'customer'].includes(patch.visibility)) throw new DocumentValidationError('Invalid visibility');
  if (patch.status && !['active', 'archived'].includes(patch.status)) throw new DocumentValidationError('Invalid status');
  db.prepare(
    `UPDATE business_documents SET title = @title, visibility = @visibility, status = @status, updated_at = datetime('now') WHERE id = @id`,
  ).run({
    id,
    title: patch.title === undefined ? current.title : patch.title?.trim().slice(0, 200) || null,
    visibility: patch.visibility ?? current.visibility,
    status: patch.status ?? current.status,
  });
  return getDocument(id, db);
}

/** Replaces the bytes of an existing document (same id, new file). */
export function replaceDocumentFile(
  id: number,
  input: { originalName: string; mimeType: string; bytes: Buffer },
  db: Database.Database = getDb(),
): BusinessDocument | undefined {
  const current = getDocument(id, db);
  if (!current) return undefined;
  const fresh = saveDocument({ ...input, visibility: current.visibility, title: current.title }, db);
  // Drop the temporary row first (stored_name is UNIQUE), then move its file under the old id.
  db.prepare('DELETE FROM business_documents WHERE id = ?').run(fresh.id);
  db.prepare(
    `UPDATE business_documents SET original_name = @original_name, stored_name = @stored_name, mime_type = @mime_type, extension = @extension,
       size_bytes = @size_bytes, sha256 = @sha256, processing = @processing, extracted_text = @extracted_text, updated_at = datetime('now') WHERE id = @id`,
  ).run({ ...fresh, id });
  try { fs.unlinkSync(path.join(uploadsDir(), current.stored_name)); } catch { /* already gone */ }
  return getDocument(id, db);
}

export function deleteDocument(id: number, db: Database.Database = getDb()): boolean {
  const current = getDocument(id, db);
  if (!current) return false;
  db.prepare('DELETE FROM business_documents WHERE id = ?').run(id);
  try { fs.unlinkSync(path.join(uploadsDir(), current.stored_name)); } catch { /* already gone */ }
  return true;
}

/** Absolute path of the stored bytes — always inside uploadsDir() (stored_name is a UUID we generated). */
export function documentPath(doc: BusinessDocument): string {
  const resolved = path.resolve(uploadsDir(), path.basename(doc.stored_name));
  if (!resolved.startsWith(uploadsDir())) throw new DocumentValidationError('Invalid document path');
  return resolved;
}

/** Content type to SERVE: HTML is downgraded to text/plain so uploaded scripts can never execute. */
export function serveContentType(doc: BusinessDocument): string {
  if (doc.extension === 'html' || doc.extension === 'htm') return 'text/plain; charset=utf-8';
  if (doc.extension === 'md' || doc.extension === 'txt') return 'text/plain; charset=utf-8';
  return doc.mime_type;
}

/** Text the AI may use: active documents marked ai_knowledge or customer with extracted text. */
export function documentsForAiContext(db: Database.Database = getDb()): { title: string; text: string; customerVisible: boolean }[] {
  return listDocuments({ status: 'active' }, db)
    .filter((d) => (d.visibility === 'ai_knowledge' || d.visibility === 'customer') && d.extracted_text)
    .map((d) => ({ title: d.title || d.original_name, text: d.extracted_text!.slice(0, 4000), customerVisible: d.visibility === 'customer' }));
}

/** Titles of documents customers may be told about (never internal ones). */
export function customerVisibleDocuments(db: Database.Database = getDb()): BusinessDocument[] {
  return listDocuments({ status: 'active', visibility: 'customer' }, db);
}
