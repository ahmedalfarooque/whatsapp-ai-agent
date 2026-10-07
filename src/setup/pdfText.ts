import { logger } from '../logger';

/**
 * PDF text extraction (pdf-parse 1.1.1 → pdf.js). Runs in-process on files the
 * dashboard already validated (extension, MIME, "%PDF" signature, 10 MB cap).
 * A PDF that is only scanned images has no text layer: that is reported as
 * such instead of being guessed at (no OCR is performed or implied).
 */

type PdfParse = (data: Uint8Array, options?: { max?: number }) => Promise<{ text: string; numpages: number }>;

let parser: PdfParse | null = null;
function loadParser(): PdfParse {
  if (!parser) {
    // The package's index.js runs a debug routine when it has no parent module; the lib entry is the parser itself.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    parser = require('pdf-parse/lib/pdf-parse.js') as PdfParse;
  }
  return parser;
}

export const MAX_EXTRACTED_CHARS = 60_000;
const EXTRACTION_TIMEOUT_MS = 20_000;

export interface PdfTextResult {
  ok: boolean;
  text: string;
  pages: number;
  /** Human-readable reason when ok is false. */
  error: string | null;
}

/** Collapses the layout whitespace pdf.js emits while keeping paragraph breaks. */
export function tidyExtractedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractPdfText(bytes: Buffer): Promise<PdfTextResult> {
  try {
    const parse = loadParser();
    // pdf.js 1.10 reads a Node Buffer's underlying ArrayBuffer from offset 0, which is wrong for the slices of Node's
    // shared pool that small files are. A plain Uint8Array copy has no such ambiguity.
    const standalone = new Uint8Array(bytes);
    const result = await Promise.race([
      parse(standalone, { max: 60 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('PDF text extraction timed out')), EXTRACTION_TIMEOUT_MS).unref()),
    ]);
    const text = tidyExtractedText(result.text ?? '').slice(0, MAX_EXTRACTED_CHARS);
    if (!text) {
      return { ok: false, text: '', pages: result.numpages ?? 0, error: 'No readable text found — this PDF looks like scanned images (OCR is not available). Upload a text-based PDF or paste the content into Business Knowledge.' };
    }
    return { ok: true, text, pages: result.numpages ?? 0, error: null };
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'PDF text extraction failed');
    return { ok: false, text: '', pages: 0, error: `Could not read this PDF (${(error as Error).message.slice(0, 120)}). It may be encrypted or damaged.` };
  }
}
