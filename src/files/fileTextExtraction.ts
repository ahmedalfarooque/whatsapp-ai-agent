import { readFileSync, statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { logger } from '../logger';
import { currentAccountId } from '../accounts/accountContext';
import { MAX_DOCUMENT_BYTES } from '../documents/documentStore';
import { extractPdfText, MAX_EXTRACTED_CHARS } from '../setup/pdfText';
import { customerFilePath, getCustomerFile, type CustomerFile } from './customerFileRepo';

/**
 * Reads the text layer of a customer's PDF so staff can search and skim it.
 *
 * - The original file is never modified or moved; the text goes into its own column with its own status, timestamp and error.
 * - Everything read is UNVERIFIED customer content: it is shown to staff with that label and is never fed to the AI as policy,
 *   business knowledge or an instruction (the AI context never reads customer files).
 * - No OCR. A scanned PDF has no text layer; that is a recorded failure and the file stays available for a person to read.
 * - Only a PDF that is already stored for THIS business is read, from inside that business's own upload folder (customerFilePath refuses
 *   any path outside it), within the document size cap, and only if it really starts with the PDF signature. Runs one file at a time
 *   with a timeout and a page/character cap, so a hostile or huge file cannot starve the server.
 * - A failure keeps the file exactly as it was (status unchanged), records why, and can be retried by staff a limited number of times.
 */

export const MAX_EXTRACTION_ATTEMPTS = 5;
const MAX_QUEUE = 25;

export type ExtractionOutcome =
  | { state: 'text_extracted'; file: CustomerFile }
  | { state: 'extraction_failed'; file: CustomerFile; error: string }
  | { state: 'skipped'; reason: 'not_found' | 'not_pdf' | 'no_file' | 'already_extracted' | 'too_many_attempts' | 'busy'; file?: CustomerFile };

/** Control characters other than tab/newline cannot carry meaning for staff and can confuse a viewer; NUL cannot be stored safely. */
export function cleanExtractedText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/[ \t]{2,}/g, ' ').trim().slice(0, MAX_EXTRACTED_CHARS);
}

function record(id: number, accountId: number, db: Database.Database, fields: { processing: 'text_extracted' | 'extraction_failed'; text: string | null; error: string | null; pages: number | null }): CustomerFile {
  db.prepare(
    `UPDATE customer_files SET processing = @processing, extracted_text = @text, extraction_error = @error, extraction_pages = @pages, extracted_at = datetime('now'),
            extraction_attempts = extraction_attempts + 1
      WHERE id = @id AND whatsapp_account_id = @accountId`,
  ).run({ id, accountId, processing: fields.processing, text: fields.text, error: fields.error, pages: fields.pages });
  return getCustomerFile(id, db, accountId)!;
}

// One extraction at a time per process: pdf.js is CPU heavy and runs on the main thread.
let chain: Promise<unknown> = Promise.resolve();
let waiting = 0;

function runSerially<T>(job: () => Promise<T>): Promise<T> | null {
  if (waiting >= MAX_QUEUE) return null;
  waiting += 1;
  const next = chain.then(job, job).finally(() => { waiting -= 1; });
  chain = next.catch(() => undefined);
  return next;
}

/**
 * Extracts the text of one customer file of the current business. `force` re-reads a file that was already extracted (staff retry);
 * without it an already-extracted file is left alone, so repeating the call is harmless.
 */
export async function extractCustomerFileText(
  fileId: number,
  options: { force?: boolean; db?: Database.Database; accountId?: number } = {},
): Promise<ExtractionOutcome> {
  const db = options.db ?? getDb();
  const accountId = options.accountId ?? currentAccountId();
  const file = getCustomerFile(fileId, db, accountId);
  if (!file) return { state: 'skipped', reason: 'not_found' };
  if (file.extension !== 'pdf') return { state: 'skipped', reason: 'not_pdf', file };
  if (!file.stored_name || file.status === 'failed' || file.status === 'too_large' || file.status === 'unsupported') return { state: 'skipped', reason: 'no_file', file };
  if (file.processing === 'text_extracted' && !options.force) return { state: 'skipped', reason: 'already_extracted', file };
  if (file.extraction_attempts >= MAX_EXTRACTION_ATTEMPTS) return { state: 'skipped', reason: 'too_many_attempts', file };

  const job = runSerially(async (): Promise<ExtractionOutcome> => {
    const fail = (error: string): ExtractionOutcome => ({ state: 'extraction_failed', file: record(file.id, accountId, db, { processing: 'extraction_failed', text: null, error, pages: null }), error });
    const full = customerFilePath(file);
    if (!full) return fail('The stored file could not be found');
    let bytes: Buffer;
    try {
      const size = statSync(full).size;
      if (size > MAX_DOCUMENT_BYTES) return fail(`The file is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB, so its text was not read`);
      bytes = readFileSync(full);
    } catch {
      return fail('The stored file could not be read');
    }
    if (bytes.subarray(0, 1024).indexOf('%PDF') === -1) return fail('The file is not a valid PDF');
    const result = await extractPdfText(bytes);
    if (!result.ok) return fail((result.error ?? 'The text could not be read').slice(0, 300));
    return { state: 'text_extracted', file: record(file.id, accountId, db, { processing: 'text_extracted', text: cleanExtractedText(result.text), error: null, pages: result.pages }) };
  });
  if (!job) return { state: 'skipped', reason: 'busy', file };
  try {
    return await job;
  } catch (error) {
    logger.warn({ account: accountId, file: fileId, reason: String((error as Error).message).slice(0, 120) }, '[FILES] text extraction crashed');
    return { state: 'extraction_failed', file: record(fileId, accountId, db, { processing: 'extraction_failed', text: null, error: 'Text extraction failed unexpectedly', pages: null }), error: 'Text extraction failed unexpectedly' };
  }
}

/** Fire-and-forget after a PDF was stored: never delays or fails the message that carried it. */
export function scheduleExtraction(file: CustomerFile): void {
  if (file.extension !== 'pdf' || !file.stored_name) return;
  const accountId = file.whatsapp_account_id;
  setImmediate(() => {
    void extractCustomerFileText(file.id, { accountId }).catch((error) => logger.warn({ account: accountId, reason: String((error as Error).message).slice(0, 120) }, '[FILES] scheduled extraction failed'));
  });
}
