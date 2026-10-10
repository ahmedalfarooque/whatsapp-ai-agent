import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { documentPath, getDocument } from '../documents/documentStore';

/**
 * The one place that decides whether an offer's attachment (an uploaded image or file) may be sent to customers.
 * It is used when an offer is saved (so the administrator hears about a bad attachment immediately) AND when it is delivered
 * (so a file that has since gone missing or been archived is never sent), and it is strictly scoped to ONE business:
 * a document id is looked up only among that business's own documents, so another business's file can never be attached,
 * previewed or sent however its id is typed.
 */

export const MAX_OFFER_FILE_BYTES = 16 * 1024 * 1024; // WhatsApp's own limit for images and documents is larger; this keeps sends quick

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);

export type OfferFileSlot = 'image' | 'document';
export type OfferFileProblem =
  | 'not_found' // no such document for this business (also what another business's id looks like)
  | 'archived'
  | 'not_for_customers' // the file is marked internal / AI-only, never to be sent to customers
  | 'not_an_image' // the image slot holds something that is not a picture
  | 'invalid_path'
  | 'file_missing' // the database row exists but the stored file is gone
  | 'file_empty'
  | 'file_too_large'
  | 'file_corrupt'; // the bytes do not match the file type

export interface OfferFile {
  documentId: number;
  /** How it is sent: a picture shows inline in the chat, anything else arrives as a file. */
  kind: 'image' | 'document';
  mimeType: string;
  extension: string;
  originalName: string;
  title: string | null;
  sizeBytes: number;
  /** Absolute path on the server. Never shown to anyone; used only to read the bytes. */
  path: string;
}

export type OfferFileCheck = { ok: true; file: OfferFile } | { ok: false; problem: OfferFileProblem };

function looksLikeItsType(bytes: Buffer, ext: string): boolean {
  switch (ext) {
    case 'pdf': return bytes.subarray(0, 4).toString('latin1') === '%PDF';
    case 'png': return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'jpg':
    case 'jpeg': return bytes[0] === 0xff && bytes[1] === 0xd8;
    case 'webp': return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'pptx':
    case 'docx': return bytes[0] === 0x50 && bytes[1] === 0x4b;
    case 'ppt':
    case 'doc': return bytes[0] === 0xd0 && bytes[1] === 0xcf;
    default: return true;
  }
}

/** Checks the database row only (no file access): enough for validating an attachment when an offer is saved. */
export function checkOfferAttachmentRecord(
  documentId: number,
  slot: OfferFileSlot,
  accountId: number = currentAccountId(),
  db: Database.Database = getDb(),
): { ok: true } | { ok: false; problem: OfferFileProblem } {
  const doc = getDocument(documentId, db, accountId); // scoped to this business: a foreign id simply does not exist here
  if (!doc) return { ok: false, problem: 'not_found' };
  if (doc.status !== 'active') return { ok: false, problem: 'archived' };
  if (doc.visibility !== 'customer') return { ok: false, problem: 'not_for_customers' };
  if (slot === 'image' && !IMAGE_EXT.has(doc.extension)) return { ok: false, problem: 'not_an_image' };
  return { ok: true };
}

/** The full check before sending: the row AND the stored file (exists, not empty, not oversized, matches its type). */
export function inspectOfferFile(
  documentId: number,
  slot: OfferFileSlot,
  accountId: number = currentAccountId(),
  db: Database.Database = getDb(),
): OfferFileCheck {
  const record = checkOfferAttachmentRecord(documentId, slot, accountId, db);
  if (!record.ok) return record;
  const doc = getDocument(documentId, db, accountId)!;
  let file: string;
  try {
    file = documentPath(doc);
  } catch {
    return { ok: false, problem: 'invalid_path' };
  }
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { ok: false, problem: 'file_missing' };
  }
  if (size === 0) return { ok: false, problem: 'file_empty' };
  if (size > MAX_OFFER_FILE_BYTES) return { ok: false, problem: 'file_too_large' };
  let head: Buffer;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      head = Buffer.alloc(12);
      fs.readSync(fd, head, 0, 12, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { ok: false, problem: 'file_missing' };
  }
  if (!looksLikeItsType(head, doc.extension)) return { ok: false, problem: 'file_corrupt' };
  return {
    ok: true,
    file: {
      documentId: doc.id,
      kind: IMAGE_EXT.has(doc.extension) ? 'image' : 'document',
      mimeType: doc.mime_type,
      extension: doc.extension,
      originalName: path.basename(doc.original_name),
      title: doc.title,
      sizeBytes: size,
      path: file,
    },
  };
}

/** Plain-language reason for the administrator when saving an offer. Never contains a path. */
export function describeOfferFileProblem(problem: OfferFileProblem, slot: OfferFileSlot): string {
  switch (problem) {
    case 'not_found': return 'This file was not found among this business\'s uploads. Upload it again from this form.';
    case 'archived': return 'This file is archived. Upload it again or choose another file.';
    case 'not_for_customers': return 'This file is marked as internal, so it cannot be sent to customers. Upload it from this form or make it customer-visible in Documents.';
    case 'not_an_image': return 'The image slot needs a picture (PNG, JPG or WEBP).';
    default: return slot === 'image' ? 'This image cannot be used.' : 'This file cannot be used.';
  }
}
