import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { env } from '../config/env';
import { MAX_DOCUMENT_BYTES } from './textExtractors';
import { runTool, type RunTool, type RunToolContext } from './safeExec';

/**
 * The first pages of a scanned PDF as PNG images, rendered with poppler's `pdftoppm` (env.PDFTOPPM_PATH, else `pdftoppm` on PATH). A PDF is UNTRUSTED input and
 * pdftoppm's own protections are not FFmpeg's, so the safeguards here are the generic ones: the file must really be a PDF (its `%PDF-` signature), the tool runs with
 * no shell and a minimal environment (no application secrets, see safeExec.ts) inside a private temporary directory that is ALWAYS removed, with a timeout, a
 * cancel signal, a bounded output (at most MAX_SCANNED_PAGES pages, each scaled to 1400 px on its long side) and every rendered file is verified to be a PNG of
 * sane size before use. Without the tool the result says so; nothing is rendered or invented.
 */
export const MAX_SCANNED_PAGES = 3;
const MAX_PAGE_PNG_BYTES = 8 * 1024 * 1024;
export type RunPdfTool = RunTool;

export type PdfPages = { ok: true; pages: Buffer[] } | { ok: false; reason: 'renderer_unavailable' | 'too_large' | 'empty' | 'not_a_pdf' | 'failed' };

/** A PDF starts with `%PDF-` (a few readers tolerate leading junk, so the first 1 KiB is searched, as the format allows). */
export const looksLikePdf = (bytes: Buffer): boolean => bytes.subarray(0, 1024).includes('%PDF-', 0, 'latin1');
const isPng = (b: Buffer): boolean => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

export async function renderPdfPages(bytes: Buffer, options: { run?: RunPdfTool; pdftoppm?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<PdfPages> {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'too_large' };
  if (!looksLikePdf(bytes)) return { ok: false, reason: 'not_a_pdf' };
  const run = options.run ?? runTool;
  const bin = options.pdftoppm ?? (env.PDFTOPPM_PATH || 'pdftoppm');
  if (!(await run(bin, ['-v'], 10_000)).ok) return { ok: false, reason: 'renderer_unavailable' };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-pdf-'));
  const context: RunToolContext = { cwd: dir, signal: options.signal };
  try {
    const input = path.join(dir, 'input.pdf');
    await fs.writeFile(input, bytes, { mode: 0o600 });
    await run(bin, ['-r', '130', '-f', '1', '-l', String(MAX_SCANNED_PAGES), '-png', '-scale-to', '1400', input, path.join(dir, 'page')], options.timeoutMs ?? 45_000, context);
    const names = (await fs.readdir(dir)).filter((n) => /^page-\d+\.png$/.test(n)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0])).slice(0, MAX_SCANNED_PAGES);
    const pages: Buffer[] = [];
    for (const name of names) {
      const page = await fs.readFile(path.join(dir, name));
      if (page.length <= MAX_PAGE_PNG_BYTES && isPng(page)) pages.push(page);
    }
    return pages.length > 0 ? { ok: true, pages } : { ok: false, reason: 'failed' };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
