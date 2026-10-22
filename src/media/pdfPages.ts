import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_DOCUMENT_BYTES } from './textExtractors';

/**
 * The first pages of a scanned PDF as PNG images, rendered with poppler's `pdftoppm` (PDFTOPPM_PATH, else `pdftoppm` on PATH). Same discipline as videoFrames: no
 * shell, a fixed input name in a private temporary directory that is ALWAYS removed, a timeout, and caps on the file size and the number of pages. Without the
 * tool the result says so; nothing is rendered or invented.
 */
export const MAX_SCANNED_PAGES = 3;
export type RunPdfTool = (bin: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean }>;
const defaultRun: RunPdfTool = (bin, args, timeoutMs) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (error) => resolve({ ok: !error }));
});

export type PdfPages = { ok: true; pages: Buffer[] } | { ok: false; reason: 'renderer_unavailable' | 'too_large' | 'empty' | 'failed' };

export async function renderPdfPages(bytes: Buffer, options: { run?: RunPdfTool; pdftoppm?: string; timeoutMs?: number } = {}): Promise<PdfPages> {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > MAX_DOCUMENT_BYTES) return { ok: false, reason: 'too_large' };
  const run = options.run ?? defaultRun;
  const bin = options.pdftoppm ?? (process.env.PDFTOPPM_PATH?.trim() || 'pdftoppm');
  if (!(await run(bin, ['-v'], 10_000)).ok) return { ok: false, reason: 'renderer_unavailable' };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-pdf-'));
  try {
    const input = path.join(dir, 'input.pdf');
    await fs.writeFile(input, bytes, { mode: 0o600 });
    await run(bin, ['-r', '130', '-f', '1', '-l', String(MAX_SCANNED_PAGES), '-png', '-scale-to', '1400', input, path.join(dir, 'page')], options.timeoutMs ?? 45_000);
    const names = (await fs.readdir(dir)).filter((n) => /^page-\d+\.png$/.test(n)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0])).slice(0, MAX_SCANNED_PAGES);
    const pages: Buffer[] = [];
    for (const name of names) pages.push(await fs.readFile(path.join(dir, name)));
    return pages.length > 0 ? { ok: true, pages } : { ok: false, reason: 'failed' };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
