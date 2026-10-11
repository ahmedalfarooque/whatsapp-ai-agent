import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/whatsapp/client')>();
  return { ...real, sendTextMessage: vi.fn(), sendInteractiveMessage: vi.fn(), sendImageMessage: vi.fn(), sendDocumentMessage: vi.fn() };
});
vi.mock('../../src/llm/agentLoop', () => ({ runAgentLoop: vi.fn() }));

import { sendTextMessage } from '../../src/whatsapp/client';
import { runAgentLoop } from '../../src/llm/agentLoop';
import { processInboundMessage } from '../../src/pipeline/processInboundMessage';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { runWithAccount } from '../../src/accounts/accountContext';
import { getCustomerByWaId } from '../../src/memory/customerRepo';
import { captureInboundFile } from '../../src/files/inboundCapture';
import { flushOutbox, onOutboxOutcome, registerOutboxSender } from '../../src/notifications/outbox';
import { handleQuotationOutcome } from '../../src/quotations/quotationService';
import { csvCell } from '../../src/customers/customerReports';

onOutboxOutcome(handleQuotationOutcome);

const OWNER = 'owner@example.com';
const PASSWORD = 'a-very-long-test-password-123';
const KNOWLEDGE = { sections: [], asPromptText: '' };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

describe('customer history, documents, reports and the quotation API', () => {
  const app = createApp();
  let A: number;
  let B: number;
  let seq = 0;
  const staff: Record<string, number> = {};
  const as = (userId: number) => {
    const cookie = `${SESSION_COOKIE_NAME}=${createSession(userId).token}`;
    const call = (method: 'get' | 'post', url: string, account?: number) => {
      const r = request(app)[method](url).set('Cookie', cookie);
      return account ? r.set('X-Whatsapp-Account', String(account)) : r;
    };
    return { get: (url: string, account?: number) => call('get', url, account), post: (url: string, account?: number) => call('post', url, account) };
  };
  let owner: ReturnType<typeof as>;
  const user = (name: string) => as(staff[name]!);
  const sent: string[] = [];
  const delivered: { text: string; attachment?: { fileId: number } }[] = [];

  async function say(account: number, waId: string, text: string, name?: string) {
    sent.length = 0;
    await processInboundMessage({ waId, messageId: `wamid.hist.${account}.${++seq}`, timestamp: Date.now(), type: 'text', text, accountId: account, contactName: name }, { knowledge: KNOWLEDGE });
    return [...sent];
  }
  const wa = () => `96578${String(++seq).padStart(7, '0')}`;
  const customerId = (account: number, waId: string) => runWithAccount(account, () => getCustomerByWaId(waId)!.id);

  /** A customer who builds a cart and submits it through the real WhatsApp menu. Returns their reference. */
  async function customerWithInquiry(account: number, name: string, item = 'Front bumper film') {
    const waId = wa();
    await say(account, waId, 'hi', name);
    await say(account, waId, '2');
    for (const m of ['9', '1', item, '2', '3', '1']) await say(account, waId, m);
    const row = getDb().prepare('SELECT reference, id FROM customer_requests WHERE customer_id = ?').get(customerId(account, waId)) as { reference: string; id: number };
    return { waId, id: customerId(account, waId), requestId: row.id, reference: row.reference };
  }

  async function receiveFile(account: number, waId: string, opts: { name?: string; mime?: string; length?: number | null; kind?: 'document' | 'image' | 'video'; identityCertain?: boolean; bytes?: Buffer; fail?: boolean } = {}) {
    const messageId = `qr:${account}:file${++seq}`;
    sent.length = 0;
    await processInboundMessage({ waId, messageId, timestamp: Date.now(), type: opts.kind ?? 'document', text: 'see attached', accountId: account }, { knowledge: KNOWLEDGE });
    const download = vi.fn(async () => { if (opts.fail) throw new Error('boom'); return opts.bytes ?? PDF; });
    const file = await captureInboundFile({
      accountId: account, customerWaId: waId, whatsappMessageId: messageId, caption: 'see attached', identityCertain: opts.identityCertain ?? true, download,
      media: { kind: opts.kind ?? 'document', mimeType: opts.mime ?? 'application/pdf', fileName: opts.name ?? 'purchase-order.pdf', fileLength: opts.length === undefined ? PDF.length : opts.length },
    });
    return { file, download, messageId, replies: [...sent] };
  }

  beforeAll(async () => {
    getDb();
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: OWNER, password: PASSWORD })).status).toBe(201);
    owner = as((getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get(OWNER) as { id: number }).id);
    A = createAccount({ name: 'History Shop A' }).id;
    B = createAccount({ name: 'History Shop B' }).id;
    const create = async (key: string, body: Record<string, unknown>) => {
      const res = await owner.post('/api/dashboard/users').send({ password: PASSWORD, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      staff[key] = res.body.id;
    };
    await create('manager', { email: 'mgr@example.com', role: 'manager', accountIds: [A] });
    await create('viewer', { email: 'viewer@example.com', role: 'user', accountIds: [A] });
    await create('noCustomers', { email: 'nc@example.com', role: 'custom', accountIds: [A], permissions: { [A]: { conversations: 'view' } } });
    await create('onlyB', { email: 'b@example.com', role: 'manager', accountIds: [B] });
  });

  beforeEach(() => {
    vi.mocked(sendTextMessage).mockReset().mockImplementation(async (_to, body) => { sent.push(String(body)); return { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 't' }] }; });
    vi.mocked(runAgentLoop).mockReset().mockResolvedValue({ finalText: 'AI answer', generatedMessages: [{ role: 'assistant', content: 'AI answer' }] });
    delivered.length = 0;
    registerOutboxSender(async (_jid, text, _account, attachment) => { delivered.push({ text, attachment }); return `wamid.out.${delivered.length}`; });
  });

  describe('permissions and account isolation', () => {
    it('every route needs a session and the customers (or requests) feature on the selected business', async () => {
      const c = await customerWithInquiry(A, 'Perm Customer');
      for (const url of [`/api/dashboard/customers/directory`, `/api/dashboard/customers/${c.id}/profile`, `/api/dashboard/customers/${c.id}/timeline`, `/api/dashboard/customers/${c.id}/documents`, `/api/dashboard/customer-reports/summary`, `/api/dashboard/customer-reports/export`, `/api/dashboard/customers/files/review`]) {
        expect((await request(app).get(url)).status, `${url} anonymous`).toBe(401);
        expect((await user('noCustomers').get(url, A)).status, `${url} without the feature`).toBe(403);
        expect((await user('viewer').get(url, A)).status, `${url} view`).toBe(200);
      }
      expect((await user('noCustomers').get(`/api/dashboard/requests/${c.requestId}/quotation`, A)).status).toBe(403);
    });

    it('viewing is not editing: a view-only user cannot add notes, edit the profile or act on a quotation', async () => {
      const c = await customerWithInquiry(A, 'View Only Customer');
      expect((await user('viewer').post(`/api/dashboard/customers/${c.id}/notes`, A).send({ body: 'x' })).status).toBe(403);
      expect((await user('viewer').post(`/api/dashboard/customers/${c.id}/profile`, A).send({ email: 'a@b.co' })).status).toBe(403);
      for (const action of ['approve', 'reject', 'send', 'mark-sent']) expect((await user('viewer').post(`/api/dashboard/requests/${c.requestId}/quotation/${action}`, A).send({ reason: 'x' })).status, action).toBe(403);
      expect((await user('viewer').post(`/api/dashboard/requests/${c.requestId}/quotation/draft`, A).send({ lines: [] })).status).toBe(403);
    });

    it('a customer, request or file of one business is "not found" from another — even for the Super Admin selecting that other business', async () => {
      const c = await customerWithInquiry(A, 'Isolated Customer');
      const f = await receiveFile(A, c.waId);
      for (const url of [`/api/dashboard/customers/${c.id}/profile`, `/api/dashboard/customers/${c.id}/timeline`, `/api/dashboard/customers/${c.id}/documents`, `/api/dashboard/customers/${c.id}/files/${f.file!.id}/download`, `/api/dashboard/customers/files/${f.file!.id}/download`, `/api/dashboard/requests/${c.requestId}/quotation`]) {
        expect((await owner.get(url, B)).status, `${url} as owner on B`).toBe(404);
        expect((await user('onlyB').get(url, A)).status, `${url} as a user of B only`).toBe(403);
      }
      expect((await owner.post(`/api/dashboard/requests/${c.requestId}/quotation/approve`, B)).status).toBe(404);
      expect((await owner.post(`/api/dashboard/customers/${c.id}/notes`, B).send({ body: 'x' })).status).toBe(404);
    });
  });

  describe('one customer, everything in one place', () => {
    it('the timeline shows the real history in order, each event with its original timestamp and a link back to the conversation', async () => {
      const c = await customerWithInquiry(A, 'Timeline Customer');
      const note = await user('manager').post(`/api/dashboard/customers/${c.id}/notes`, A).send({ body: 'Prefers calls after 4pm', followUpAt: '2099-01-15', requestId: c.requestId });
      expect(note.status, JSON.stringify(note.body)).toBe(201);
      await receiveFile(A, c.waId);
      const draft = await user('manager').post(`/api/dashboard/requests/${c.requestId}/quotation/draft`, A).send({ currency: 'SAR', taxRatePercent: '15', lines: [{ description: 'Front bumper film', quantity: '2', unitPrice: '150' }] });
      expect(draft.status, JSON.stringify(draft.body)).toBe(200);
      expect((await user('manager').post(`/api/dashboard/requests/${c.requestId}/quotation/versions/${draft.body.version.id}/finalize`, A)).status).toBe(200);
      expect((await user('manager').post(`/api/dashboard/requests/${c.requestId}/quotation/approve`, A)).status).toBe(200);
      const queued = await user('manager').post(`/api/dashboard/requests/${c.requestId}/quotation/send`, A);
      expect(queued.status).toBe(202);
      for (let i = 0; i < 3; i += 1) { await flushOutbox(); await new Promise((r) => setTimeout(r, 5)); }

      const tl = await user('viewer').get(`/api/dashboard/customers/${c.id}/timeline?order=asc&limit=200`, A);
      expect(tl.status).toBe(200);
      const types = tl.body.events.map((e: { type: string }) => e.type);
      for (const expected of ['first_contact', 'cart_item_added', 'cart_submitted', 'inquiry', 'document_received', 'follow_up', 'quotation_prepared', 'quotation_finalized', 'quotation_sent', 'status_change']) expect(types, expected).toContain(expected);
      const times = tl.body.events.map((e: { at: string }) => e.at);
      expect([...times].sort()).toEqual(times); // chronological
      const inquiry = tl.body.events.find((e: { type: string }) => e.type === 'inquiry');
      expect(inquiry).toMatchObject({ reference: c.reference, requestId: c.requestId });
      expect(inquiry.conversationId).toBeGreaterThan(0);
      const received = tl.body.events.find((e: { type: string }) => e.type === 'document_received');
      expect(received.whatsappMessageId).toMatch(/^qr:/); // the original WhatsApp message is preserved
      expect(received.conversationId).toBeGreaterThan(0);
      const approved = tl.body.events.find((e: { type: string; title: string }) => e.type === 'status_change' && e.title.includes('approved'));
      expect(approved.actor).toBeTruthy(); // who did it

      expect(delivered.filter((d) => d.text.includes(`${c.reference}-Q1`))).toHaveLength(1);
      const detail = await user('viewer').get(`/api/dashboard/requests/${c.requestId}/quotation`, A);
      expect(detail.body.request.status).toBe('sent');
    });

    it('timeline search, type filter, date window and paging work on the server', async () => {
      const c = await customerWithInquiry(A, 'Search Customer', 'Rare ceramic coating');
      const search = await owner.get(`/api/dashboard/customers/${c.id}/timeline?q=ceramic`, A);
      expect(search.body.events.length).toBeGreaterThan(0);
      expect(search.body.events.every((e: { title: string; detail: string | null }) => `${e.title} ${e.detail ?? ''}`.toLowerCase().includes('ceramic'))).toBe(true);
      expect((await owner.get(`/api/dashboard/customers/${c.id}/timeline?q=zzzz-not-there`, A)).body.total).toBe(0);
      const onlyCart = await owner.get(`/api/dashboard/customers/${c.id}/timeline?types=cart_item_added`, A);
      expect(onlyCart.body.events.map((e: { type: string }) => e.type)).toEqual(['cart_item_added']);
      expect((await owner.get(`/api/dashboard/customers/${c.id}/timeline?from=2099-01-01`, A)).body.total).toBe(0);
      const page = await owner.get(`/api/dashboard/customers/${c.id}/timeline?limit=2&offset=0`, A);
      expect(page.body.events).toHaveLength(2);
      expect(page.body.total).toBeGreaterThan(2);
    });

    it('a removed cart item stays on the timeline (added, then removed) instead of vanishing', async () => {
      const waId = wa();
      await say(A, waId, 'hi', 'Remover');
      await say(A, waId, '2');
      for (const m of ['9', '1', 'Wrong item', 'skip', '2', '1']) await say(A, waId, m);
      const tl = await owner.get(`/api/dashboard/customers/${customerId(A, waId)}/timeline?limit=100`, A);
      const types = tl.body.events.map((e: { type: string }) => e.type);
      expect(types).toContain('cart_item_added');
      expect(types).toContain('cart_item_removed');
    });

    it('profile fields and notes are staff-only, validated, and scoped to this customer', async () => {
      const c = await customerWithInquiry(A, 'Profile Customer');
      const bad = await user('manager').post(`/api/dashboard/customers/${c.id}/profile`, A).send({ email: 'not an email' });
      expect(bad.status).toBe(400);
      const ok = await user('manager').post(`/api/dashboard/customers/${c.id}/profile`, A).send({ email: 'buyer@example.com', companyName: 'Al Noor Fleet' });
      expect(ok.body.customer).toMatchObject({ email: 'buyer@example.com', company_name: 'Al Noor Fleet' });
      const other = await customerWithInquiry(A, 'Other Customer');
      const foreignRequest = await user('manager').post(`/api/dashboard/customers/${c.id}/notes`, A).send({ body: 'x', requestId: other.requestId });
      expect(foreignRequest.status).toBe(400);
      const n = await user('manager').post(`/api/dashboard/customers/${c.id}/notes`, A).send({ body: 'Call back', followUpAt: '2020-01-01' });
      const profile = await owner.get(`/api/dashboard/customers/${c.id}/profile`, A);
      expect(profile.body.stats).toMatchObject({ followUpsOutstanding: 1, followUpsOverdue: 1, notes: 1 });
      expect((await user('manager').post(`/api/dashboard/customers/${c.id}/notes/${n.body.note.id}/done`, A)).status).toBe(200);
      expect((await owner.get(`/api/dashboard/customers/${c.id}/profile`, A)).body.stats.followUpsOutstanding).toBe(0);
      // a customer never sees staff notes: the status lookup shows only the request
      const out = await say(A, c.waId, '9');
      expect(out.join('\n')).not.toContain('Call back');
    });
  });

  describe('documents', () => {
    it('a received document is stored once with its metadata and linked to the message; re-delivery never duplicates it; the customer gets NO reply', async () => {
      const c = await customerWithInquiry(A, 'Doc Customer');
      const first = await receiveFile(A, c.waId);
      expect(first.replies).toEqual([]); // non-text inbound stays silent
      expect(vi.mocked(runAgentLoop)).not.toHaveBeenCalled();
      expect(first.file).toMatchObject({ direction: 'inbound', kind: 'document', status: 'stored', original_name: 'purchase-order.pdf', mime_type: 'application/pdf', caption: 'see attached', whatsapp_account_id: A });
      expect(first.file!.message_row_id).toBeGreaterThan(0);
      expect(first.file!.conversation_id).toBeGreaterThan(0);
      const again = await captureInboundFile({ accountId: A, customerWaId: c.waId, whatsappMessageId: first.messageId, identityCertain: true, download: async () => PDF, media: { kind: 'document', mimeType: 'application/pdf', fileName: 'purchase-order.pdf', fileLength: PDF.length } });
      expect(again!.id).toBe(first.file!.id);
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM customer_files WHERE whatsapp_message_id = ?').get(first.messageId)).toEqual({ n: 1 });
    });

    it('limits and failures are recorded for staff, never thrown, and a too-large file is not even downloaded', async () => {
      const c = await customerWithInquiry(A, 'Limit Customer');
      const big = await receiveFile(A, c.waId, { length: 50 * 1024 * 1024 });
      expect(big.file).toMatchObject({ status: 'too_large', stored_name: null });
      expect(big.download).not.toHaveBeenCalled();
      const exe = await receiveFile(A, c.waId, { name: 'tool.exe', mime: 'application/octet-stream' });
      expect(exe.file).toMatchObject({ status: 'unsupported' });
      const html = await receiveFile(A, c.waId, { name: 'page.html', mime: 'text/html' });
      expect(html.file).toMatchObject({ status: 'unsupported' });
      const broken = await receiveFile(A, c.waId, { fail: true });
      expect(broken.file).toMatchObject({ status: 'failed', error: expect.stringContaining('could not be downloaded') });
      const fake = await receiveFile(A, c.waId, { bytes: Buffer.from('not a pdf at all'), name: 'fake.pdf' });
      expect(fake.file?.status).not.toBe('stored'); // content must match the type
      const video = await receiveFile(A, c.waId, { kind: 'video', mime: 'video/mp4', name: 'clip.mp4' });
      expect(video.file).toMatchObject({ status: 'unsupported', stored_name: null });
      const docs = await owner.get(`/api/dashboard/customers/${c.id}/documents`, A);
      expect(docs.body.documents.length).toBeGreaterThanOrEqual(6);
      for (const d of docs.body.documents) expect(d.file).not.toHaveProperty('stored_name');
    });

    it('uncertain identity is kept but flagged for staff, who can attach it to the right customer of THIS business only', async () => {
      const c = await customerWithInquiry(A, 'Known Customer');
      const stranger = await customerWithInquiry(A, 'Real Owner');
      const f = await receiveFile(A, c.waId, { identityCertain: false });
      expect(f.file).toMatchObject({ status: 'needs_review' });
      const review = await user('manager').get('/api/dashboard/customers/files/review', A);
      expect(review.body.files.some((x: { file: { id: number } }) => x.file.id === f.file!.id)).toBe(true);
      const otherBusinessCustomer = await customerWithInquiry(B, 'B Customer');
      expect((await user('manager').post(`/api/dashboard/customers/files/${f.file!.id}/assign`, A).send({ customerId: otherBusinessCustomer.id })).status).toBe(404);
      expect((await user('viewer').post(`/api/dashboard/customers/files/${f.file!.id}/assign`, A).send({ customerId: stranger.id })).status).toBe(403);
      const assigned = await user('manager').post(`/api/dashboard/customers/files/${f.file!.id}/assign`, A).send({ customerId: stranger.id });
      expect(assigned.status).toBe(200);
      expect(assigned.body.file).toMatchObject({ customer_id: stranger.id, status: 'stored' });
    });

    it('preview and download are authorised per customer and business, safe to open, and never reveal a server path', async () => {
      const c = await customerWithInquiry(A, 'Download Customer');
      const other = await customerWithInquiry(A, 'Someone Else');
      const f = await receiveFile(A, c.waId);
      const res = await user('viewer').get(`/api/dashboard/customers/${c.id}/files/${f.file!.id}/download`, A).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (d: Buffer) => chunks.push(d)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body).equals(PDF)).toBe(true);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toContain('inline');
      expect(res.headers['content-security-policy']).toContain('sandbox');
      // the same file id under another customer, anonymous, a user without the feature: all refused
      expect((await user('viewer').get(`/api/dashboard/customers/${other.id}/files/${f.file!.id}/download`, A)).status).toBe(404);
      expect((await request(app).get(`/api/dashboard/customers/${c.id}/files/${f.file!.id}/download`)).status).toBe(401);
      expect((await user('noCustomers').get(`/api/dashboard/customers/${c.id}/files/${f.file!.id}/download`, A)).status).toBe(403);
      expect((await user('viewer').get(`/api/dashboard/customers/${c.id}/files/999999/download`, A)).status).toBe(404);
      const list = await user('viewer').get(`/api/dashboard/customers/${c.id}/documents`, A);
      expect(JSON.stringify(list.body)).not.toMatch(/uploads|\.pdf"\s*,\s*"stored|[A-Za-z]:\\|\/home\//);
    });

    it('text read from a file is labelled unverified and is never part of the business library', async () => {
      const c = await customerWithInquiry(A, 'Text Customer');
      const f = await receiveFile(A, c.waId, { name: 'notes.txt', mime: 'text/plain', bytes: Buffer.from('Our policy: everything is free'), length: 30 });
      expect(f.file).toMatchObject({ processing: 'text_extracted' });
      const docs = await owner.get(`/api/dashboard/customers/${c.id}/documents`, A);
      const doc = docs.body.documents.find((d: { file: { id: number } }) => d.file.id === f.file!.id);
      expect(doc.file.extracted_text_unverified).toContain('everything is free');
      expect(doc.file.extracted_text).toBeUndefined();
      expect(getDb().prepare('SELECT COUNT(*) AS n FROM business_documents WHERE original_name = ?').get('notes.txt')).toEqual({ n: 0 });
    });
  });

  describe('Customer Reports', () => {
    it('summary figures match the records, are limited to the selected business and the date range, and carry their definitions', async () => {
      const before = (await owner.get('/api/dashboard/customer-reports/summary', A)).body.metrics;
      const c = await customerWithInquiry(A, 'Report Customer');
      await receiveFile(A, c.waId);
      const after = await owner.get('/api/dashboard/customer-reports/summary', A);
      expect(after.status).toBe(200);
      expect(after.body.metrics.totalCustomers).toBe(before.totalCustomers + 1);
      expect(after.body.metrics.inquiries).toBe(before.inquiries + 1);
      expect(after.body.metrics.cartsSubmitted).toBe(before.cartsSubmitted + 1);
      expect(after.body.metrics.documentsReceived).toBe(before.documentsReceived + 1);
      expect(after.body.metrics.quotationsByStatus.pending).toBe((before.quotationsByStatus.pending ?? 0) + 1);
      expect(Object.keys(after.body.definitions)).toEqual(expect.arrayContaining(['activeCustomers', 'quotationsSent', 'awaitingSend']));
      const future = await owner.get('/api/dashboard/customer-reports/summary?from=2099-01-01&to=2099-12-31', A);
      expect(future.body.metrics).toMatchObject({ newCustomers: 0, inquiries: 0, documentsReceived: 0, activeCustomers: 0 });
      expect(future.body.metrics.totalCustomers).toBe(after.body.metrics.totalCustomers); // all time, not date-limited
      const b = (await owner.get('/api/dashboard/customer-reports/summary', B)).body.metrics;
      expect(b.totalCustomers).toBeLessThan(after.body.metrics.totalCustomers);
    });

    it('the directory filters by request status, open work, language, documents, follow-ups and search, and counts match', async () => {
      const c = await customerWithInquiry(A, 'Directory Customer', 'Unique-sku-7788');
      await receiveFile(A, c.waId);
      await user('manager').post(`/api/dashboard/customers/${c.id}/notes`, A).send({ body: 'ring', followUpAt: '2020-02-02' });
      const get = (q: string) => owner.get(`/api/dashboard/customers/directory?${q}`, A);
      expect((await get(`search=${c.reference}`)).body.items.map((i: { id: number }) => i.id)).toEqual([c.id]);
      expect((await get('search=Unique')).body.total).toBe(0); // item text is not a customer field
      expect((await get('requestStatus=pending&openOnly=1&hasFiles=1&followUp=overdue&language=en')).body.items.some((i: { id: number }) => i.id === c.id)).toBe(true);
      expect((await get(`search=${c.reference}&requestStatus=sent`)).body.total).toBe(0);
      expect((await get(`search=${c.reference}&language=ar`)).body.total).toBe(0);
      const row = (await get(`search=${c.reference}`)).body.items[0];
      expect(row).toMatchObject({ inquiries: 1, openRequests: 1, files: 1, openCart: 0 });
      expect(row.nextFollowUpAt).toBeTruthy();
      expect((await owner.get(`/api/dashboard/customers/directory?search=${c.reference}`, B)).body.total).toBe(0);
      const summary = (await owner.get('/api/dashboard/customer-reports/summary', A)).body.metrics;
      expect((await get('openOnly=1&limit=100')).body.total).toBeGreaterThan(0);
      expect(summary.openRequests).toBeGreaterThan(0);
    });

    it('CSV exports contain only this business\'s customers, read correctly in Excel (BOM), and cannot run as formulas', async () => {
      const c = await customerWithInquiry(A, '=HYPERLINK("http://evil","click")');
      const other = await customerWithInquiry(B, 'B Only Customer');
      const res = await owner.get('/api/dashboard/customer-reports/export?dataset=customers', A);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.text.charCodeAt(0)).toBe(0xfeff);
      expect(res.text).toContain(c.waId);
      expect(res.text).not.toContain(other.waId);
      expect(res.text).not.toMatch(/(^|,)"?=HYPERLINK/m); // the formula is neutralised
      expect(res.text).toContain(`'=HYPERLINK`);
      const quotes = await owner.get('/api/dashboard/customer-reports/export?dataset=quotations', A);
      expect(quotes.text).toContain(c.reference);
      expect(quotes.text).not.toContain(other.reference);
      expect((await user('noCustomers').get('/api/dashboard/customer-reports/export', A)).status).toBe(403);
      expect(csvCell('a,b')).toBe('"a,b"');
      expect(csvCell('say "hi"')).toBe('"say ""hi"""');
      expect(csvCell('+1 555')).toBe("'+1 555");
    });
  });
});
