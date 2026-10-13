import { inflateRawSync } from 'node:zlib';

/**
 * A minimal, safe reader for the ZIP containers Office documents are made of (docx/xlsx/pptx): the central directory is parsed, and only
 * the named entries are inflated, each capped in size (a "zip bomb" never grows past the cap). Nothing is executed or interpreted;
 * the bytes are returned as-is. Stored (0) and Deflate (8) entries only — everything else is skipped.
 */

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

export function listZipEntries(buf: Buffer): ZipEntry[] {
  // End of central directory: scan the last 64 KiB + 22 bytes
  const min = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + cdSize > buf.length) throw new Error('corrupt zip (central directory out of range)');
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= buf.length; i += 1) {
    if (buf.readUInt32LE(p) !== CDH_SIG) throw new Error('corrupt zip (bad central directory header)');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, compressedSize, uncompressedSize, method, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** The bytes of one entry, or null when it is missing, too large or uses an unsupported method. Never throws on a bad entry. */
export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer | null {
  if (entry.uncompressedSize > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES) return null;
  const p = entry.localHeaderOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LFH_SIG) return null;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buf.length) return null;
  const data = buf.subarray(start, end);
  try {
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  } catch {
    return null;
  }
  return null;
}

export function readZipText(buf: Buffer, name: string): string | null {
  const entry = listZipEntries(buf).find((e) => e.name === name);
  if (!entry) return null;
  const bytes = readZipEntry(buf, entry);
  return bytes ? bytes.toString('utf8') : null;
}
