import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAccount } from '../../../src/accounts/accountRepo';
import { deleteAccount } from '../../../src/accounts/accountDeletion';
import { setAccountFeature, FEATURES } from '../../../src/accounts/accountFeatures';
import { uploadCatalogue, listCatalogues } from '../../../src/catalogues/catalogueRepo';
import { documentPath, getDocument } from '../../../src/documents/documentStore';
import { makePdf } from '../../fixtures/makePdf';

describe('deleting a business that has catalogues', () => {
  it('removes its catalogues, their files, the feature flag — and nothing of the other business', async () => {
    getDb();
    const doomed = createAccount({ name: 'Doomed Paint Shop' });
    const keeper = createAccount({ name: 'Keeper Paint Shop' });
    for (const a of [doomed, keeper]) setAccountFeature(a.id, FEATURES.CATALOGUES, true);
    const gone = await uploadCatalogue({ originalName: 'a.pdf', mimeType: 'application/pdf', bytes: makePdf(['doomed catalogue']), title: 'Doomed' }, doomed.id);
    const kept = await uploadCatalogue({ originalName: 'b.pdf', mimeType: 'application/pdf', bytes: makePdf(['kept catalogue']), title: 'Kept' }, keeper.id);
    const goneFile = documentPath(getDocument(gone.documentId, undefined, doomed.id)!);
    const keptFile = documentPath(getDocument(kept.documentId, undefined, keeper.id)!);
    expect(fs.existsSync(goneFile)).toBe(true);

    const report = await deleteAccount(doomed.id, 'DELETE', { discardConnection: async () => ({ loggedOut: true }) });
    expect(report.rows.catalogues).toBe(1);
    expect(report.rows.features).toBe(1);

    const count = (sql: string, ...p: unknown[]) => (getDb().prepare(sql).get(...p) as { n: number }).n;
    expect(count('SELECT COUNT(*) n FROM account_catalogues WHERE whatsapp_account_id = ?', doomed.id)).toBe(0);
    expect(count('SELECT COUNT(*) n FROM account_features WHERE whatsapp_account_id = ?', doomed.id)).toBe(0);
    expect(count('SELECT COUNT(*) n FROM business_documents WHERE whatsapp_account_id = ?', doomed.id)).toBe(0);
    expect(fs.existsSync(goneFile)).toBe(false);

    expect(listCatalogues(keeper.id).map((c) => c.title)).toEqual(['Kept']);
    expect(fs.existsSync(keptFile)).toBe(true);
  });
});
