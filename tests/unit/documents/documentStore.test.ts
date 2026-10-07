import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../src/memory/db';
import {
  saveDocument, listDocuments, updateDocument, deleteDocument, replaceDocumentFile, documentPath, serveContentType,
  documentsForAiContext, customerVisibleDocuments, htmlToText, validateDocument, DocumentValidationError, MAX_DOCUMENT_BYTES, uploadsDir,
} from '../../../src/documents/documentStore';

let db: Database.Database;
beforeEach(() => {
  db = createTestDb();
});
afterAll(() => {
  fs.rmSync(uploadsDir(), { recursive: true, force: true });
});

const PDF = Buffer.from('%PDF-1.4\n%fake\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);

describe('business documents — validation', () => {
  it('accepts allow-listed types whose bytes match, rejects everything else', () => {
    expect(validateDocument({ originalName: 'brochure.pdf', mimeType: 'application/pdf', bytes: PDF })).toEqual({ ext: 'pdf', mime: 'application/pdf' });
    expect(() => validateDocument({ originalName: 'run.exe', mimeType: 'application/octet-stream', bytes: PDF })).toThrow(DocumentValidationError);
    expect(() => validateDocument({ originalName: 'fake.pdf', mimeType: 'application/pdf', bytes: Buffer.from('not a pdf') })).toThrow(/does not look like/);
    expect(() => validateDocument({ originalName: 'x.png', mimeType: 'application/pdf', bytes: PNG })).toThrow(/MIME type/);
    expect(() => validateDocument({ originalName: 'empty.txt', mimeType: 'text/plain', bytes: Buffer.alloc(0) })).toThrow(/empty/);
    expect(() => validateDocument({ originalName: 'big.txt', mimeType: 'text/plain', bytes: Buffer.alloc(MAX_DOCUMENT_BYTES + 1) })).toThrow(/exceeds/);
  });

  it('never trusts the client file name for the storage path', () => {
    const doc = saveDocument({ originalName: '../../etc/passwd.txt', mimeType: 'text/plain', bytes: Buffer.from('hello') }, db);
    expect(doc.original_name).toBe('passwd.txt');
    expect(documentPath(doc).startsWith(uploadsDir())).toBe(true);
    expect(fs.existsSync(documentPath(doc))).toBe(true);
  });
});

describe('business documents — lifecycle, safety, AI context', () => {
  it('extracts text from txt/md/html (tags and scripts stripped) and serves HTML as plain text', () => {
    const html = saveDocument({ originalName: 'page.html', mimeType: 'text/html', bytes: Buffer.from('<h1>Rowad</h1><script>alert(1)</script><p>PPF &amp; tint</p>'), visibility: 'ai_knowledge' }, db);
    expect(html.processing).toBe('text_extracted');
    expect(html.extracted_text).toBe('Rowad PPF & tint');
    expect(serveContentType(html)).toBe('text/plain; charset=utf-8');
    expect(htmlToText('<b>a</b>&nbsp;<i>b</i>')).toBe('a b');
    const pdf = saveDocument({ originalName: 'list.pdf', mimeType: 'application/pdf', bytes: PDF }, db);
    expect(pdf.processing).toBe('stored'); // text is read by extractDocumentText() right after upload
    expect(serveContentType(pdf)).toBe('application/pdf');
  });

  it('visibility drives the AI context and customer-visible lists; archived docs drop out', () => {
    const internal = saveDocument({ originalName: 'notes.txt', mimeType: 'text/plain', bytes: Buffer.from('internal notes'), visibility: 'internal' }, db);
    const ai = saveDocument({ originalName: 'facts.md', mimeType: 'text/markdown', bytes: Buffer.from('# Facts'), visibility: 'ai_knowledge' }, db);
    const cust = saveDocument({ originalName: 'brochure.txt', mimeType: 'text/plain', bytes: Buffer.from('Brochure'), visibility: 'customer', title: 'Brochure 2026' }, db);
    const ctx = documentsForAiContext(db);
    expect(ctx.map((d) => d.title)).toEqual(['Brochure 2026', 'facts.md']);
    expect(ctx.find((d) => d.title === 'Brochure 2026')?.customerVisible).toBe(true);
    expect(customerVisibleDocuments(db).map((d) => d.id)).toEqual([cust.id]);
    expect(updateDocument(internal.id, { visibility: 'customer' }, db)?.visibility).toBe('customer');
    expect(updateDocument(cust.id, { status: 'archived' }, db)?.status).toBe('archived');
    expect(customerVisibleDocuments(db).map((d) => d.id)).toEqual([internal.id]);
    expect(listDocuments({ status: 'archived' }, db)).toHaveLength(1);
    expect(() => updateDocument(ai.id, { visibility: 'public' as never }, db)).toThrow(DocumentValidationError);
  });

  it('replace swaps the bytes under the same id and delete removes row + file', () => {
    const doc = saveDocument({ originalName: 'a.txt', mimeType: 'text/plain', bytes: Buffer.from('v1') }, db);
    const oldPath = documentPath(doc);
    const replaced = replaceDocumentFile(doc.id, { originalName: 'b.txt', mimeType: 'text/plain', bytes: Buffer.from('v2 text') }, db)!;
    expect(replaced.id).toBe(doc.id);
    expect(replaced.original_name).toBe('b.txt');
    expect(replaced.extracted_text).toBe('v2 text');
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(listDocuments({}, db)).toHaveLength(1);
    const p = documentPath(replaced);
    expect(deleteDocument(doc.id, db)).toBe(true);
    expect(fs.existsSync(p)).toBe(false);
    expect(deleteDocument(doc.id, db)).toBe(false);
  });
});
