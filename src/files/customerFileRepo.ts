import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { ALLOWED_TYPES, MAX_DOCUMENT_BYTES, uploadsDirFor, validateDocument } from '../documents/documentStore';

/**
 * Files that belong to ONE CUSTOMER: what they sent us (a photo of the car, a drawing, a purchase order) and what we sent them (the
 * quotation document). Same folder tree, size cap and content checks as the business document library (documents/documentStore.ts),
 * but a separate table: a customer's file can never become a business document, reach the AI's context, or be offered to another
 * customer. Everything is scoped to one business; a file id from another business is simply "not found".
 *
 * Text extracted from a file is stored apart from the file and is ALWAYS unverified customer content — nothing treats it as policy.
 */

export type FileDirection = 'inbound' | 'outbound';
export type FileKind = 'document' | 'image' | 'video' | 'audio' | 'other';
export type FileStatus = 'stored' | 'failed' | 'too_large' | 'unsupported' | 'needs_review';

export interface CustomerFile {
  id: number;
  whatsapp_account_id: number;
  customer_id: number | null;
  direction: FileDirection;
  kind: FileKind;
  purpose: string | null;
  original_name: string | null;
  stored_name: string | null;
  mime_type: string | null;
  extension: string | null;
  size_bytes: number | null;
  sha256: string | null;
  caption: string | null;
  conversation_id: number | null;
  whatsapp_message_id: string | null;
  message_row_id: number | null;
  request_id: number | null;
  quotation_version_id: number | null;
  status: FileStatus;
  error: string | null;
  processing: 'stored' | 'text_extracted' | 'extraction_failed' | 'unsupported';
  extracted_text: string | null;
  uploaded_by_admin_id: number | null;
  created_at: string;
}

/** What a customer's file may be. Web pages (html/htm) are excluded: a customer-supplied page must never be served by this application. */
export const CUSTOMER_FILE_EXTENSIONS: ReadonlySet<string> = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'txt']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);

export class CustomerFileError extends Error {
  status = 400;
}

export function kindForExtension(ext: string): FileKind {
  return IMAGE_EXT.has(ext) ? 'image' : 'document';
}

export interface SaveCustomerFileInput {
  customerId: number | null;
  direction: FileDirection;
  bytes: Buffer;
  originalName: string;
  mimeType: string;
  caption?: string | null;
  conversationId?: number | null;
  whatsappMessageId?: string | null;
  messageRowId?: number | null;
  requestId?: number | null;
  quotationVersionId?: number | null;
  purpose?: string | null;
  uploadedByAdminId?: number | null;
  /** Identity uncertain: the file is kept but left for staff to attach to the right customer. */
  needsReview?: boolean;
  accountId?: number;
  maxBytes?: number;
}

/**
 * Validates and stores one file. An inbound file is stored once per WhatsApp message and business: a re-delivered message returns
 * the row already stored. Throws CustomerFileError for a file we do not accept (the caller records that as a failed row).
 */
export function saveCustomerFile(input: SaveCustomerFileInput, db: Database.Database = getDb()): CustomerFile {
  const accountId = input.accountId ?? currentAccountId();
  if (input.direction === 'inbound' && input.whatsappMessageId) {
    const existing = db.prepare(`SELECT id FROM customer_files WHERE whatsapp_account_id = ? AND whatsapp_message_id = ? AND direction = 'inbound'`).get(accountId, input.whatsappMessageId) as { id: number } | undefined;
    if (existing) return getCustomerFile(existing.id, db, accountId)!;
  }
  let checked: { ext: string; mime: string };
  try {
    checked = validateDocument({ originalName: input.originalName, mimeType: input.mimeType, bytes: input.bytes, maxBytes: input.maxBytes ?? MAX_DOCUMENT_BYTES });
  } catch (error) {
    throw new CustomerFileError((error as Error).message);
  }
  if (!CUSTOMER_FILE_EXTENSIONS.has(checked.ext) || !ALLOWED_TYPES[checked.ext]) throw new CustomerFileError(`File type .${checked.ext} is not accepted for customer files`);

  const storedName = `${randomUUID()}.${checked.ext}`;
  const dir = uploadsDirFor(accountId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, storedName), input.bytes);

  const text = checked.ext === 'txt' ? input.bytes.toString('utf8').slice(0, 20_000) : null;
  try {
    const result = db
      .prepare(
        `INSERT INTO customer_files (whatsapp_account_id, customer_id, direction, kind, purpose, original_name, stored_name, mime_type, extension, size_bytes, sha256,
           caption, conversation_id, whatsapp_message_id, message_row_id, request_id, quotation_version_id, status, processing, extracted_text, uploaded_by_admin_id)
         VALUES (@accountId, @customerId, @direction, @kind, @purpose, @originalName, @storedName, @mime, @ext, @size, @sha, @caption, @conversationId, @messageId,
           @messageRowId, @requestId, @versionId, @status, @processing, @text, @adminId)`,
      )
      .run({
        accountId,
        customerId: input.customerId,
        direction: input.direction,
        kind: kindForExtension(checked.ext),
        purpose: input.purpose ?? null,
        originalName: path.basename(input.originalName).slice(0, 200),
        storedName,
        mime: checked.mime,
        ext: checked.ext,
        size: input.bytes.length,
        sha: createHash('sha256').update(input.bytes).digest('hex'),
        caption: input.caption?.trim().slice(0, 1000) || null,
        conversationId: input.conversationId ?? null,
        messageId: input.whatsappMessageId ?? null,
        messageRowId: input.messageRowId ?? null,
        requestId: input.requestId ?? null,
        versionId: input.quotationVersionId ?? null,
        status: input.needsReview || input.customerId === null ? 'needs_review' : 'stored',
        processing: text !== null ? 'text_extracted' : 'stored',
        text,
        adminId: input.uploadedByAdminId ?? null,
      });
    return getCustomerFile(Number(result.lastInsertRowid), db, accountId)!;
  } catch (error) {
    fs.rmSync(path.join(dir, storedName), { force: true }); // never leave an orphan file behind a failed insert
    if (String((error as Error).message).includes('UNIQUE') && input.whatsappMessageId) {
      const existing = db.prepare(`SELECT id FROM customer_files WHERE whatsapp_account_id = ? AND whatsapp_message_id = ? AND direction = 'inbound'`).get(accountId, input.whatsappMessageId) as { id: number } | undefined;
      if (existing) return getCustomerFile(existing.id, db, accountId)!;
    }
    throw error;
  }
}

/** Records a file that could NOT be stored (too large, unsupported, download failed) so staff see it and why, instead of it vanishing. */
export function recordFailedCustomerFile(
  input: {
    customerId: number | null; kind: FileKind; status: Exclude<FileStatus, 'stored' | 'needs_review'>; error: string; originalName?: string | null; mimeType?: string | null;
    sizeBytes?: number | null; caption?: string | null; conversationId?: number | null; whatsappMessageId?: string | null; messageRowId?: number | null; accountId?: number;
  },
  db: Database.Database = getDb(),
): CustomerFile | undefined {
  const accountId = input.accountId ?? currentAccountId();
  try {
    const result = db
      .prepare(
        `INSERT INTO customer_files (whatsapp_account_id, customer_id, direction, kind, original_name, mime_type, size_bytes, caption, conversation_id, whatsapp_message_id, message_row_id, status, error, processing)
         VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unsupported')`,
      )
      .run(accountId, input.customerId, input.kind, input.originalName?.slice(0, 200) ?? null, input.mimeType?.slice(0, 100) ?? null, input.sizeBytes ?? null, input.caption?.slice(0, 1000) ?? null,
        input.conversationId ?? null, input.whatsappMessageId ?? null, input.messageRowId ?? null, input.status, input.error.slice(0, 300));
    return getCustomerFile(Number(result.lastInsertRowid), db, accountId);
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE')) return undefined; // this message already has a record
    throw error;
  }
}

export function getCustomerFile(id: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): CustomerFile | undefined {
  return db.prepare('SELECT * FROM customer_files WHERE id = ? AND whatsapp_account_id = ?').get(id, accountId) as CustomerFile | undefined;
}

export interface FileListParams {
  customerId?: number;
  requestId?: number;
  direction?: FileDirection;
  status?: FileStatus;
  /** Files whose customer is not certain (needs_review) or unknown, across the business. */
  unassigned?: boolean;
  limit?: number;
  offset?: number;
  accountId?: number;
}

export function listCustomerFiles(params: FileListParams = {}, db: Database.Database = getDb()): CustomerFile[] {
  const where = ['whatsapp_account_id = @accountId'];
  if (params.customerId !== undefined) where.push('customer_id = @customerId');
  if (params.requestId !== undefined) where.push('request_id = @requestId');
  if (params.direction) where.push('direction = @direction');
  if (params.status) where.push('status = @status');
  if (params.unassigned) where.push(`(customer_id IS NULL OR status = 'needs_review')`);
  return db
    .prepare(`SELECT * FROM customer_files WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT @limit OFFSET @offset`)
    .all({
      accountId: params.accountId ?? currentAccountId(), customerId: params.customerId, requestId: params.requestId, direction: params.direction, status: params.status,
      limit: Math.max(1, Math.min(params.limit ?? 100, 500)), offset: Math.max(0, params.offset ?? 0),
    }) as CustomerFile[];
}

/** Links a file to the request/quotation it belongs to (same business only). */
export function linkFileToRequest(fileId: number, requestId: number, quotationVersionId: number | null, db: Database.Database = getDb(), accountId: number = currentAccountId()): void {
  db.prepare('UPDATE customer_files SET request_id = ?, quotation_version_id = ? WHERE id = ? AND whatsapp_account_id = ?').run(requestId, quotationVersionId, fileId, accountId);
}

/** Staff resolves an uncertain file: attach it to the right customer of this business. */
export function assignFileToCustomer(fileId: number, customerId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): CustomerFile | undefined {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ? AND whatsapp_account_id = ?').get(customerId, accountId);
  if (!customer) return undefined;
  const r = db.prepare(`UPDATE customer_files SET customer_id = ?, status = CASE WHEN status = 'needs_review' THEN 'stored' ELSE status END WHERE id = ? AND whatsapp_account_id = ?`).run(customerId, fileId, accountId);
  return r.changes ? getCustomerFile(fileId, db, accountId) : undefined;
}

/** Absolute path of a stored file, only ever inside this business's upload folder. Null if the record has no file or the path would escape. */
export function customerFilePath(file: CustomerFile): string | null {
  if (!file.stored_name) return null;
  const dir = path.resolve(uploadsDirFor(file.whatsapp_account_id));
  const full = path.resolve(dir, file.stored_name);
  return full.startsWith(dir + path.sep) ? full : null;
}

export function readCustomerFile(file: CustomerFile): Buffer | null {
  const full = customerFilePath(file);
  if (!full) return null;
  try {
    return fs.readFileSync(full);
  } catch {
    return null;
  }
}

/** What the browser may be told: metadata only. The stored name and the server path are never exposed. */
export function publicFile(file: CustomerFile): Record<string, unknown> {
  const { stored_name: _stored, sha256: _sha, ...rest } = file;
  return { ...rest, extracted_text_unverified: file.extracted_text, extracted_text: undefined, previewable: file.status === 'stored' && Boolean(file.stored_name) };
}
