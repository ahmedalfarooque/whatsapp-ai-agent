import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { documentKindOf, extractDocumentText, MAX_PROMPT_CHARS } from '../../../src/media/textExtractors';
import { listZipEntries, readZipEntry } from '../../../src/media/zipRead';

// Office files are ZIP containers; these tests build real (minimal) ones in memory, so the reader is exercised end to end without fixtures on disk.
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) { c ^= b; for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; }
  return (c ^ 0xffffffff) >>> 0;
}
function zip(entries: Record<string, string>, opts: { store?: boolean } = {}): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8');
    const data = opts.store ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(opts.store ? 0 : 8, 8); lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(opts.store ? 0 : 8, 10); ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, data); centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(centrals.length / 2, 8); eocd.writeUInt16LE(centrals.length / 2, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('zip reader', () => {
  it('lists entries and inflates deflated or stored data; a missing or oversized entry is null, garbage throws', () => {
    const buf = zip({ 'a.txt': 'hello', 'b/c.xml': '<x>1</x>' });
    const entries = listZipEntries(buf);
    expect(entries.map((e) => e.name)).toEqual(['a.txt', 'b/c.xml']);
    expect(readZipEntry(buf, entries[0]!)!.toString()).toBe('hello');
    expect(readZipEntry(zip({ s: 'stored' }, { store: true }), listZipEntries(zip({ s: 'stored' }, { store: true }))[0]!)!.toString()).toBe('stored');
    expect(readZipEntry(buf, { ...entries[0]!, uncompressedSize: 1e9 })).toBeNull();
    expect(() => listZipEntries(Buffer.from('not a zip at all, really not'))).toThrow(/not a zip/);
  });
});

describe('document text extraction', () => {
  it('knows which types it can read, by MIME or by extension', () => {
    expect(documentKindOf('application/pdf', 'x.pdf')).toBe('pdf');
    expect(documentKindOf('application/octet-stream', 'quote.docx')).toBe('docx');
    expect(documentKindOf('text/csv', null)).toBe('text');
    expect(documentKindOf('application/msword', 'old.doc')).toBeNull();
    expect(documentKindOf('video/mp4', 'clip.mp4')).toBeNull();
  });
  it('reads a Word document\'s paragraphs', async () => {
    const docx = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Quotation for</w:t></w:r><w:r><w:t xml:space="preserve"> Camry 2021</w:t></w:r></w:p><w:p><w:r><w:t>Part no. 90915-YZZD4 &amp; filter</w:t></w:r></w:p></w:body></w:document>' });
    const r = await extractDocumentText({ bytes: docx, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'quote.docx' });
    expect(r.ok && r.text).toBe('Quotation for Camry 2021\nPart no. 90915-YZZD4 & filter');
  });
  it('reads an Excel sheet with shared and inline strings as rows', async () => {
    const xlsx = zip({
      'xl/sharedStrings.xml': '<sst><si><t>Item</t></si><si><t>Price</t></si><si><t>Tint film</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c t="s"><v>2</v></c><c><v>350</v></c></row><row><c t="inlineStr"><is><t>Note</t></is></c></row></sheetData></worksheet>',
    });
    const r = await extractDocumentText({ bytes: xlsx, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: 'prices.xlsx' });
    expect(r.ok && r.text).toBe('--- sheet1 ---\nItem | Price\nTint film | 350\nNote');
    expect(r.ok && r.units).toBe(1);
  });
  it('reads PowerPoint slides in order', async () => {
    const pptx = zip({ 'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>', 'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>First slide</a:t></a:r></a:p></p:sld>' });
    const r = await extractDocumentText({ bytes: pptx, mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', fileName: 'deck.pptx' });
    expect(r.ok && r.text).toBe('--- slide 1 ---\nFirst slide\n--- slide 2 ---\nSecond');
  });
  it('reads plain text, caps what the model sees, and reports empty, corrupt, unsupported and oversized files honestly', async () => {
    const long = 'x'.repeat(MAX_PROMPT_CHARS + 500);
    const r = await extractDocumentText({ bytes: Buffer.from(long), mimeType: 'text/plain', fileName: 'notes.txt' });
    expect(r.ok && r.truncated).toBe(true);
    expect(r.ok && r.text).toContain('[... truncated: 500 more characters]');
    expect(await extractDocumentText({ bytes: Buffer.from('   '), mimeType: 'text/plain', fileName: 'e.txt' })).toMatchObject({ ok: false, reason: 'empty' });
    expect(await extractDocumentText({ bytes: Buffer.from('nope'), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'x.docx' })).toMatchObject({ ok: false, reason: 'corrupt' });
    expect(await extractDocumentText({ bytes: zip({ 'other.xml': '<a/>' }), mimeType: null, fileName: 'x.docx' })).toMatchObject({ ok: false, reason: 'corrupt' });
    expect(await extractDocumentText({ bytes: Buffer.from('x'), mimeType: 'application/msword', fileName: 'x.doc' })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await extractDocumentText({ bytes: Buffer.alloc(11 * 1024 * 1024), mimeType: 'text/plain', fileName: 'big.txt' })).toMatchObject({ ok: false, reason: 'too_large' });
    expect(await extractDocumentText({ bytes: Buffer.from('%PDF-1.4 garbage'), mimeType: 'application/pdf', fileName: 'x.pdf' })).toMatchObject({ ok: false });
  });
});
