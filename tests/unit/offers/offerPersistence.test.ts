import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('I. offer attachments survive a restart', () => {
  const previousPath = process.env.DATABASE_PATH;
  let dir: string | null = null;

  afterEach(async () => {
    try {
      (await import('../../../src/memory/db')).closeDb();
    } catch {
      /* already closed */
    }
    process.env.DATABASE_PATH = previousPath;
    vi.resetModules();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('the offers, their attachment references and the stored files are all still there — for every business — after the database is closed and reopened', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offers-persist-'));
    process.env.DATABASE_PATH = path.join(dir, 'app.db');
    vi.resetModules();

    // ---- the running server: businesses upload files and publish offers
    let db = await import('../../../src/memory/db');
    db.getDb();
    const { createAccount } = await import('../../../src/accounts/accountRepo');
    const { saveDocument } = await import('../../../src/documents/documentStore');
    const { createOffer, setOfferStatus } = await import('../../../src/offers/offerRepo');
    const second = createAccount({ name: 'Persistence Shop' }).id;
    const files = new Map<number, { image: Buffer; pdf: Buffer }>();
    for (const accountId of [1, second]) {
      const image = Buffer.concat([PNG_SIGNATURE, Buffer.from(`image-of-account-${accountId}`)]);
      const pdf = Buffer.from(`%PDF-1.4 pdf of account ${accountId}`);
      const imageDoc = saveDocument({ originalName: 'o.png', mimeType: 'image/png', bytes: image, visibility: 'customer', accountId });
      const pdfDoc = saveDocument({ originalName: 'o.pdf', mimeType: 'application/pdf', bytes: pdf, visibility: 'customer', accountId });
      const offer = createOffer({ titleAr: 'عرض', titleEn: `Offer of ${accountId}`, imageDocumentId: imageDoc.id, documentId: pdfDoc.id }, 'test', undefined, accountId);
      setOfferStatus(offer.id, 'published', 'test', undefined, accountId);
      files.set(accountId, { image, pdf });
    }
    const { customerOfferMedia } = await import('../../../src/offers/offerMedia');
    const before = [1, second].map((accountId) => customerOfferMedia('en', new Date(), undefined, accountId).items.map((i) => ({ title: i.title, kind: i.kind, mime: i.mimeType, file: i.fileName })));
    expect(before.map((b) => b.length)).toEqual([2, 2]);

    // ---- the server stops and starts again: nothing is kept in memory
    db.closeDb();
    vi.resetModules();
    db = await import('../../../src/memory/db');
    db.getDb();
    const reopened = await import('../../../src/offers/offerMedia');
    const { getOffer } = await import('../../../src/offers/offerRepo');
    const fsModule = await import('node:fs');

    for (const accountId of [1, second]) {
      const items = reopened.customerOfferMedia('en', new Date(), undefined, accountId).items;
      expect(items.map((i) => ({ title: i.title, kind: i.kind, mime: i.mimeType, file: i.fileName }))).toEqual(before[accountId === 1 ? 0 : 1]);
      const image = items.find((i) => i.kind === 'image')!;
      const pdf = items.find((i) => i.kind === 'document')!;
      expect(fsModule.default.readFileSync(image.path).equals(files.get(accountId)!.image)).toBe(true);
      expect(fsModule.default.readFileSync(pdf.path).equals(files.get(accountId)!.pdf)).toBe(true);
      // The files live in the data folder next to the database (never in the code folder or Git), one tree per business.
      expect(path.resolve(image.path).startsWith(path.resolve(dir!))).toBe(true);
      expect(path.resolve(image.path).includes(path.join('accounts', String(accountId)))).toBe(accountId !== 1);
      const stored = getOffer(image.offerId, undefined, accountId)!;
      expect(stored.image_document_id).toBeGreaterThan(0);
      expect(stored.document_id).toBeGreaterThan(0);
    }
    // Each business's files are in its own folder, never the other's.
    const first = reopened.customerOfferMedia('en', new Date(), undefined, 1).items[0]!.path;
    const other = reopened.customerOfferMedia('en', new Date(), undefined, second).items[0]!.path;
    expect(path.dirname(first)).not.toBe(path.dirname(other));
  });
});
