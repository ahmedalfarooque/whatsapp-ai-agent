import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { runWithAccount } from '../../src/accounts/accountContext';
import { getOrCreateCustomer } from '../../src/memory/customerRepo';
import { customerFilePath, getCustomerFile, readCustomerFile, saveCustomerFile } from '../../src/files/customerFileRepo';
import { MAX_EXTRACTION_ATTEMPTS, cleanExtractedText, extractCustomerFileText } from '../../src/files/fileTextExtraction';
import { makePdf, TINY_PNG } from '../fixtures/makePdf';

const OWNER = 'owner@example.com';
const PASSWORD = 'a-very-long-test-password-123';

describe('text extraction for customer PDFs', () => {
  const app = createApp();
  let A: number;
  let B: number;
  let seq = 0;
  const staff: Record<string, number> = {};
  const as = (userId: number) => {
    const cookie = `${SESSION_COOKIE_NAME}=${createSession(userId).token}`;
    return { post: (url: string, account?: number) => { const r = request(app).post(url).set('Cookie', cookie); return account ? r.set('X-Whatsapp-Account', String(account)) : r; } };
  };

  const store = (account: number, bytes: Buffer, name = 'purchase-order.pdf', mime = 'application/pdf') =>
    runWithAccount(account, () => {
      const customer = getOrCreateCustomer(`96577${String(++seq).padStart(7, '0')}`, 'Layla');
      return saveCustomerFile({ customerId: customer.id, direction: 'inbound', bytes, originalName: name, mimeType: mime, whatsappMessageId: `qr:${account}:ext${seq}` });
    });
  const extract = (account: number, id: number, force = false) => runWithAccount(account, () => extractCustomerFileText(id, { force }));

  beforeAll(async () => {
    getDb();
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: OWNER, password: PASSWORD })).status).toBe(201);
    A = createAccount({ name: 'Extraction Shop A' }).id;
    B = createAccount({ name: 'Extraction Shop B' }).id;
    const owner = as((getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get(OWNER) as { id: number }).id);
    for (const [key, body] of Object.entries({
      manager: { email: 'mgr@example.com', role: 'manager', accountIds: [A] },
      viewer: { email: 'viewer@example.com', role: 'user', accountIds: [A] },
      onlyB: { email: 'b@example.com', role: 'manager', accountIds: [B] },
    })) {
      const res = await owner.post('/api/dashboard/users').send({ password: PASSWORD, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      staff[key] = res.body.id;
    }
  });

  it('reads the text layer into its own column with status, page count and timestamp, and leaves the original file untouched', async () => {
    const pdf = makePdf(['Purchase order 4471', 'Ceramic coating for 12 vans']);
    const file = store(A, pdf);
    const before = fs.readFileSync(customerFilePath(file)!);

    const out = await extract(A, file.id);
    expect(out.state).toBe('text_extracted');
    const after = getCustomerFile(file.id, undefined, A)!;
    expect(after).toMatchObject({ processing: 'text_extracted', extraction_pages: 1, extraction_attempts: 1, extraction_error: null, status: 'stored' });
    expect(after.extracted_text).toContain('Purchase order 4471');
    expect(after.extracted_text).toContain('Ceramic coating for 12 vans');
    expect(after.extracted_at).toBeTruthy();
    // the original is byte-for-byte what the customer sent
    expect(readCustomerFile(after)!.equals(before)).toBe(true);
    expect(after.sha256).toBe(file.sha256);
  });

  it('is idempotent: without force an extracted file is left alone; a forced retry re-reads and counts the attempt', async () => {
    const file = store(A, makePdf(['Quotation request']));
    await extract(A, file.id);
    const again = await extract(A, file.id);
    expect(again).toMatchObject({ state: 'skipped', reason: 'already_extracted' });
    expect(getCustomerFile(file.id, undefined, A)!.extraction_attempts).toBe(1);
    expect((await extract(A, file.id, true)).state).toBe('text_extracted');
    expect(getCustomerFile(file.id, undefined, A)!.extraction_attempts).toBe(2);
  });

  it('a PDF with no text layer (scanned) is a recorded failure, not a guess: no OCR, the file is kept for manual review', async () => {
    const file = store(A, makePdf([]));
    const out = await extract(A, file.id);
    expect(out.state).toBe('extraction_failed');
    const row = getCustomerFile(file.id, undefined, A)!;
    expect(row).toMatchObject({ processing: 'extraction_failed', extracted_text: null, status: 'stored', extraction_attempts: 1 });
    expect(row.extraction_error).toMatch(/scanned|No readable text/i);
    expect(row.extracted_at).toBeTruthy();
    expect(readCustomerFile(row)).not.toBeNull(); // still there to open
  });

  it('a damaged PDF fails safely with a short message that contains no server path', async () => {
    const file = store(A, Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'));
    const out = await extract(A, file.id);
    expect(out.state).toBe('extraction_failed');
    const row = getCustomerFile(file.id, undefined, A)!;
    expect(row.processing).toBe('extraction_failed');
    expect(row.extraction_error!.length).toBeLessThanOrEqual(300);
    expect(row.extraction_error).not.toContain(path.sep === '\\' ? ':\\' : '/uploads');
    expect(row.extraction_error).not.toContain(row.stored_name!);
  });

  it('only a PDF is read: an image is skipped untouched (no OCR)', async () => {
    const file = store(A, TINY_PNG, 'car.png', 'image/png');
    expect(await extract(A, file.id)).toMatchObject({ state: 'skipped', reason: 'not_pdf' });
    expect(getCustomerFile(file.id, undefined, A)).toMatchObject({ processing: 'stored', extraction_attempts: 0, extracted_text: null });
  });

  it('is scoped to the business: another business cannot read, or even see, the file', async () => {
    const file = store(A, makePdf(['Private order']));
    expect(await extract(B, file.id)).toMatchObject({ state: 'skipped', reason: 'not_found' });
    expect(getCustomerFile(file.id, undefined, A)).toMatchObject({ processing: 'stored', extracted_text: null, extraction_attempts: 0 });
  });

  it('never reads outside the business upload folder, even if a stored name was tampered with', async () => {
    const file = store(A, makePdf(['Inside']));
    getDb().prepare('UPDATE customer_files SET stored_name = ? WHERE id = ?').run('../../../package.json', file.id);
    const out = await extract(A, file.id);
    expect(out.state).toBe('extraction_failed');
    const row = getCustomerFile(file.id, undefined, A)!;
    expect(row.extracted_text).toBeNull();
    expect(row.extraction_error).toMatch(/could not be found/i);
    expect(customerFilePath(row)).toBeNull();
  });

  it('stops after the retry limit instead of looping on a file that cannot be read', async () => {
    const file = store(A, makePdf([]));
    getDb().prepare('UPDATE customer_files SET extraction_attempts = ? WHERE id = ?').run(MAX_EXTRACTION_ATTEMPTS, file.id);
    expect(await extract(A, file.id, true)).toMatchObject({ state: 'skipped', reason: 'too_many_attempts' });
  });

  it('extracted text is stored as inert data: control characters are removed and the length is capped; text that looks like instructions is only text', () => {
    expect(cleanExtractedText('a\u0000b\u0007c\td\n e')).toBe('a b c\td\n e');
    expect(cleanExtractedText('x'.repeat(200_000)).length).toBeLessThanOrEqual(60_000);
  });

  it('the AI/business-knowledge code never reads customer file text', () => {
    const root = path.resolve(__dirname, '../../src');
    const allowed = [`${path.sep}files${path.sep}`, `${path.sep}customers${path.sep}`, `${path.sep}dashboard${path.sep}`, `${path.sep}migrations${path.sep}`];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !allowed.some((a) => full.includes(a)) && /extracted_text|extractedText/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(root, full));
      }
    };
    walk(root);
    // setup/, documents/ and catalogues/ handle the BUSINESS libraries (different tables), not customer files.
    expect(offenders.filter((f) => !/^(setup|documents|catalogues)[\\/]/.test(f))).toEqual([]);
  });

  describe('the staff endpoint', () => {
    it('lets staff with edit access retry; view-only staff and other businesses are refused', async () => {
      const file = store(A, makePdf(['Endpoint order']));
      const url = `/api/dashboard/customers/files/${file.id}/extract`;
      expect((await request(app).post(url)).status).toBe(401);
      expect((await as(staff.viewer!).post(url, A)).status).toBe(403);
      expect((await as(staff.onlyB!).post(url, B)).status).toBe(404); // another business: not found
      const ok = await as(staff.manager!).post(url, A);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.state).toBe('text_extracted');
      expect(ok.body.file.extracted_text_unverified).toContain('Endpoint order');
      expect(ok.body.file.stored_name).toBeUndefined(); // the server path is never exposed
      expect(ok.body.file.extracted_text).toBeUndefined();
      expect(ok.body.file).toMatchObject({ processing: 'text_extracted', extraction_pages: 1 });
    });

    it('reports a clear reason for a file with nothing to read', async () => {
      const png = store(A, TINY_PNG, 'car.png', 'image/png');
      const res = await as(staff.manager!).post(`/api/dashboard/customers/files/${png.id}/extract`, A);
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe('not_pdf');
      expect((await as(staff.manager!).post('/api/dashboard/customers/files/abc/extract', A)).status).toBe(400);
    });
  });
});
