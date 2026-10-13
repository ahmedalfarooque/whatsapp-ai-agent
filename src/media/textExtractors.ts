import { extractPdfText } from '../setup/pdfText';
import { listZipEntries, readZipEntry } from './zipRead';

/**
 * Text extraction for the files customers send: what the assistant may READ before answering. Every extractor is pure (bytes in, text
 * out), bounded (size / page / character caps) and honest: a file whose text cannot be read says so with a reason instead of pretending.
 * Nothing here executes macros, scripts or embedded objects — Office files are read as the XML inside their ZIP container only.
 *
 * Supported: PDF (text layer; a scanned PDF has none and is reported as such — there is no OCR here), DOCX, XLSX, PPTX, TXT/MD/CSV/JSON.
 * Not supported: DOC/PPT (binary legacy formats), images-as-documents, archives, everything else.
 */

export type DocumentKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text';
export type DocumentTextFailure = 'unsupported' | 'too_large' | 'no_text_layer' | 'corrupt' | 'empty' | 'extraction_failed';

export interface DocumentTextOk {
  ok: true;
  kind: DocumentKind;
  text: string;
  /** PDF pages / slides / sheets, when known. */
  units?: number;
  chars: number;
  truncated: boolean;
}
export interface DocumentTextFailed {
  ok: false;
  kind: DocumentKind | 'unknown';
  reason: DocumentTextFailure;
  detail?: string;
}
export type DocumentTextResult = DocumentTextOk | DocumentTextFailed;

/** Only this much of a file's text is shown to the model for one message (the full text stays in the customer file record). */
export const MAX_PROMPT_CHARS = 12_000;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/x-markdown']);
const KIND_BY_EXT: Record<string, DocumentKind> = { pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', pptx: 'pptx', txt: 'text', md: 'text', csv: 'text', json: 'text' };
const KIND_BY_MIME: Record<string, DocumentKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** The extractor that would handle this file, or null when the type is not readable here. */
export function documentKindOf(mimeType: string | null | undefined, fileName: string | null | undefined): DocumentKind | null {
  const mime = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  const ext = fileName && fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  return KIND_BY_MIME[mime] ?? (TEXT_MIMES.has(mime) ? 'text' : null) ?? KIND_BY_EXT[ext] ?? null;
}

export const isExtractableDocument = (mimeType: string | null | undefined, fileName: string | null | undefined): boolean => documentKindOf(mimeType, fileName) !== null;

function xmlText(xml: string): string {
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/(w:p|a:p|p)>/g, '\n')
    .replace(/<w:br[^>]*\/>|<a:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
}

function tidy(text: string): string {
  return text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function finish(kind: DocumentKind, text: string, units?: number): DocumentTextResult {
  const clean = tidy(text);
  if (!clean) return { ok: false, kind, reason: 'empty' };
  const truncated = clean.length > MAX_PROMPT_CHARS;
  return { ok: true, kind, text: truncated ? `${clean.slice(0, MAX_PROMPT_CHARS)}\n[... truncated: ${clean.length - MAX_PROMPT_CHARS} more characters]` : clean, units, chars: clean.length, truncated };
}

function docxText(bytes: Buffer): DocumentTextResult {
  const entries = listZipEntries(bytes);
  const main = entries.find((e) => e.name === 'word/document.xml');
  if (!main) return { ok: false, kind: 'docx', reason: 'corrupt', detail: 'word/document.xml missing' };
  const xml = readZipEntry(bytes, main);
  if (!xml) return { ok: false, kind: 'docx', reason: 'too_large' };
  return finish('docx', xmlText(xml.toString('utf8')));
}

function xlsxText(bytes: Buffer): DocumentTextResult {
  const entries = listZipEntries(bytes);
  const sharedEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  const shared: string[] = [];
  if (sharedEntry) {
    const xml = readZipEntry(bytes, sharedEntry)?.toString('utf8') ?? '';
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText(m[1]!).trim());
  }
  const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (sheets.length === 0) return { ok: false, kind: 'xlsx', reason: 'corrupt', detail: 'no worksheets' };
  const out: string[] = [];
  for (const sheet of sheets) {
    const xml = readZipEntry(bytes, sheet)?.toString('utf8');
    if (!xml) continue;
    out.push(`--- ${sheet.name.replace('xl/worksheets/', '').replace('.xml', '')} ---`);
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of row[1]!.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1]!;
        const inner = cell[2]!;
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
        const inline = /<is>([\s\S]*?)<\/is>/.exec(inner)?.[1];
        if (/t="s"/.test(attrs)) cells.push(shared[Number(v)] ?? '');
        else if (inline !== undefined) cells.push(xmlText(inline).trim());
        else cells.push(xmlText(v).trim());
      }
      if (cells.some((c) => c)) out.push(cells.join(' | '));
    }
  }
  return finish('xlsx', out.join('\n'), sheets.length);
}

function pptxText(bytes: Buffer): DocumentTextResult {
  const entries = listZipEntries(bytes);
  const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (slides.length === 0) return { ok: false, kind: 'pptx', reason: 'corrupt', detail: 'no slides' };
  const out: string[] = [];
  slides.forEach((slide, i) => {
    const xml = readZipEntry(bytes, slide)?.toString('utf8');
    if (!xml) return;
    out.push(`--- slide ${i + 1} ---\n${xmlText(xml).trim()}`);
  });
  return finish('pptx', out.join('\n'), slides.length);
}

/** Reads the text of one customer file. Never throws. */
export async function extractDocumentText(input: { bytes: Buffer; mimeType: string | null | undefined; fileName: string | null | undefined }): Promise<DocumentTextResult> {
  const kind = documentKindOf(input.mimeType, input.fileName);
  if (!kind) return { ok: false, kind: 'unknown', reason: 'unsupported' };
  if (input.bytes.length === 0) return { ok: false, kind, reason: 'empty' };
  if (input.bytes.length > MAX_DOCUMENT_BYTES) return { ok: false, kind, reason: 'too_large' };
  try {
    if (kind === 'text') return finish('text', input.bytes.toString('utf8'));
    if (kind === 'pdf') {
      const pdf = await extractPdfText(input.bytes);
      if (!pdf.ok) return { ok: false, kind, reason: /no text layer|OCR/i.test(pdf.error ?? '') ? 'no_text_layer' : 'extraction_failed', detail: pdf.error ?? undefined };
      return finish('pdf', pdf.text, pdf.pages);
    }
    if (kind === 'docx') return docxText(input.bytes);
    if (kind === 'xlsx') return xlsxText(input.bytes);
    return pptxText(input.bytes);
  } catch (error) {
    return { ok: false, kind, reason: 'corrupt', detail: String((error as Error).message).slice(0, 120) };
  }
}
