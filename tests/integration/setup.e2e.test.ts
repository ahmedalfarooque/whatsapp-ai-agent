import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { grantAccountAccess, revokeAccountAccess, dataDir } from '../../src/accounts/accountRepo';
import { hashPassword } from '../../src/dashboard/auth';
import { setLinkFetcher } from '../../src/setup/linkFetcher';
import { knowledgeDirForAccount } from '../../src/knowledge/paths';
import { makePdf, TINY_PNG } from '../fixtures/makePdf';

const PRICE_LIST = 'Services\n- Haircut — 50 SAR\n- Manicure | classic nail care | 80 SAR\n\nOffers\n- Weekend special: 20% off haircuts\n\nFAQ\nQ: Do you take walk-ins? A: Yes, subject to availability.\n';

describe('business setup — HTTP API', () => {
  const app = createApp();
  const agent = request.agent(app);
  let salon: number;
  let disposable: number;
  let adminId: number;

  const upload = (id: number, name: string, body: Buffer, headers: Record<string, string> = {}) =>
    agent.post(`/api/dashboard/accounts/${id}/setup/files`).set('Content-Type', 'application/octet-stream').set('X-File-Name', encodeURIComponent(name)).set(headers).send(body);

  beforeAll(async () => {
    const setup = await agent.post('/api/dashboard/auth/setup').send({ username: 'setup-admin', password: 'a-very-long-test-password-123' });
    expect(setup.status).toBe(201);
    adminId = (getDb().prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: number }).id;
    salon = (await agent.post('/api/dashboard/accounts').send({ name: 'Noor Salon', nameAr: 'صالون نور', businessCategory: 'Beauty salon' })).body.id;
    disposable = (await agent.post('/api/dashboard/accounts').send({ name: 'Disposable Co', businessCategory: 'Restaurant' })).body.id;
    setLinkFetcher(async (url) => {
      if (url.includes('blocked')) return { ok: false, httpStatus: 403, title: null, text: '', error: 'The site refused automated access (HTTP 403).', sha256: null };
      return { ok: true, httpStatus: 200, title: 'Noor', text: 'Services\n- Pedicure — 90 SAR\nEmail: hello@noor.example', error: null, sha256: 'h' };
    });
  });
  afterAll(() => setLinkFetcher(null));

  it('is behind the dashboard login', async () => {
    const res = await request(app).get(`/api/dashboard/accounts/${salon}/setup`);
    expect(res.status).toBe(401);
  });

  it('opens the setup workspace of one business: information, links, files, menu, AI status', async () => {
    const res = await agent.get(`/api/dashboard/accounts/${salon}/setup`);
    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ id: salon, name: 'Noor Salon', isLegacy: false });
    expect(res.body.profile.settings.businessName).toBe('Noor Salon');
    expect(res.body.profile.settings.googleMapsUrl).toBe(''); // no other business's map link
    expect(res.body.profile.settings.hoursConfigured).toBe(false);
    expect(res.body).toMatchObject({ links: [], documents: [], images: [], draft: null });
    expect(res.body.menu).toMatchObject({ builtIn: false, source: 'default' });
    expect(res.body.menu.config.items.length).toBeGreaterThan(5);
    expect(res.body.ai).toHaveProperty('available');
    expect(res.body.purposes).toContain('price_list');
    expect((await agent.get('/api/dashboard/accounts/9999/setup')).status).toBe(404);
  });

  it('saves business information with per-field validation', async () => {
    const bad = await agent.put(`/api/dashboard/accounts/${salon}/setup/profile`).send({ contactEmail: 'not-an-email', contactPhone: 'abc' });
    expect(bad.status).toBe(400);
    expect(Object.keys(bad.body.fields)).toEqual(expect.arrayContaining(['contactEmail', 'contactPhone']));
    const ok = await agent.put(`/api/dashboard/accounts/${salon}/setup/profile`).send({
      descriptionEn: 'A neighbourhood salon offering hair and nail care.', descriptionAr: 'صالون حي للعناية بالشعر والأظافر', addressEn: 'Tahlia Street, Jeddah',
      googleMapsUrl: 'https://maps.app.goo.gl/noor123', contactPhone: '+966 50 000 1111', contactEmail: 'hello@noor.example', businessHoursStart: '10:00', businessHoursEnd: '22:00',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.settings).toMatchObject({ contactPhone: '+966 50 000 1111', hoursConfigured: true, googleMapsConfigured: true });
    // the original business is untouched
    const original = await agent.get('/api/dashboard/business-profile');
    expect(original.body.settings.contactPhone).toBeNull();
  });

  it('manages business links: add, categorise, edit, read, report failures, remove', async () => {
    const add = await agent.post(`/api/dashboard/accounts/${salon}/setup/links`).send({ url: 'noor.example', label: 'Website' });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ kind: 'website', status: 'pending', url: 'https://noor.example/' });
    const blocked = await agent.post(`/api/dashboard/accounts/${salon}/setup/links`).send({ url: 'https://blocked.example/page', kind: 'other' });
    expect(blocked.status).toBe(201);
    expect((await agent.post(`/api/dashboard/accounts/${salon}/setup/links`).send({ url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await agent.post(`/api/dashboard/accounts/${salon}/setup/links`).send({ url: 'noor.example' })).status).toBe(400); // duplicate

    const read = await agent.post(`/api/dashboard/accounts/${salon}/setup/links/read/all`);
    expect(read.status).toBe(200);
    const byUrl = Object.fromEntries(read.body.links.map((l: { url: string }) => [l.url, l]));
    expect(byUrl['https://noor.example/']).toMatchObject({ status: 'ok', httpStatus: 200 });
    expect(byUrl['https://blocked.example/page']).toMatchObject({ status: 'unavailable', httpStatus: 403, error: expect.stringContaining('refused') });
    expect(JSON.stringify(read.body)).not.toContain('Pedicure'); // page text stays on the server

    const edit = await agent.put(`/api/dashboard/accounts/${salon}/setup/links/${blocked.body.id}`).send({ kind: 'menu', label: 'Menu page' });
    expect(edit.body).toMatchObject({ kind: 'menu', label: 'Menu page' });
    // another business can neither see nor change them
    expect((await agent.put(`/api/dashboard/accounts/${disposable}/setup/links/${blocked.body.id}`).send({ label: 'x' })).status).toBe(404);
    expect((await agent.delete(`/api/dashboard/accounts/${disposable}/setup/links/${blocked.body.id}`)).status).toBe(404);
    expect((await agent.get(`/api/dashboard/accounts/${disposable}/setup/links`)).body.links).toEqual([]);
    expect((await agent.delete(`/api/dashboard/accounts/${salon}/setup/links/${blocked.body.id}`)).status).toBe(200);
  });

  it('uploads PDFs, text and images per account; reads PDF text; refuses unsafe files', async () => {
    const txt = await upload(salon, 'prices.txt', Buffer.from(PRICE_LIST), { 'Content-Type': 'text/plain', 'X-Purpose': 'price_list', 'X-Title': encodeURIComponent('Price list 2026') });
    expect(txt.status).toBe(201);
    expect(txt.body).toMatchObject({ kind: 'document', processing: 'text_extracted', purpose: 'price_list', title: 'Price list 2026', whatsapp_account_id: salon });
    expect(txt.body).not.toHaveProperty('stored_name');

    const pdf = await upload(salon, 'catalogue.pdf', makePdf(['Products', '- Argan shampoo - 35 SAR']), { 'Content-Type': 'application/pdf', 'X-Purpose': 'product_catalogue' });
    expect(pdf.status).toBe(201);
    expect(pdf.body).toMatchObject({ kind: 'document', processing: 'text_extracted', hasExtractedText: true, purpose: 'product_catalogue' });

    const broken = await upload(salon, 'scan.pdf', Buffer.from('%PDF-1.4\nnot a real pdf at all'), { 'Content-Type': 'application/pdf' });
    expect(broken.status).toBe(201);
    expect(broken.body).toMatchObject({ processing: 'extraction_failed', hasExtractedText: false });
    expect(broken.body.processing_error).toMatch(/Could not read this PDF|No readable text/);

    const png = await upload(salon, 'front.png', TINY_PNG, { 'Content-Type': 'image/png', 'X-Purpose': 'storefront', 'X-Caption': encodeURIComponent('Our shop front') });
    expect(png.status).toBe(201);
    expect(png.body).toMatchObject({ kind: 'image', purpose: 'storefront', caption: 'Our shop front' });

    expect((await upload(salon, 'malware.exe', Buffer.from('MZ'), { 'Content-Type': 'application/octet-stream' })).status).toBe(400);
    expect((await upload(salon, 'fake.png', Buffer.from('not a png'), { 'Content-Type': 'image/png' })).status).toBe(400);
    expect((await upload(salon, 'empty.txt', Buffer.alloc(0), { 'Content-Type': 'text/plain' })).status).toBe(400);
    const traversal = await upload(salon, '../../../etc/passwd.txt', Buffer.from('x'), { 'Content-Type': 'text/plain' });
    expect(traversal.status).toBe(201);
    expect(traversal.body.original_name).toBe('passwd.txt');
    const stored = getDb().prepare('SELECT stored_name FROM business_documents WHERE id = ?').get(traversal.body.id) as { stored_name: string };
    expect(stored.stored_name).toMatch(/^[0-9a-f-]{36}\.txt$/);
    expect(fs.existsSync(path.join(dataDir(), 'accounts', String(salon), 'uploads', stored.stored_name))).toBe(true);

    const patched = await agent.patch(`/api/dashboard/accounts/${salon}/setup/files/${png.body.id}`).send({ caption: 'Shop front at night', purpose: 'promo_image' });
    expect(patched.body).toMatchObject({ caption: 'Shop front at night', purpose: 'promo_image' });

    const listing = await agent.get(`/api/dashboard/accounts/${salon}/setup/files`);
    expect(listing.body.documents.length).toBeGreaterThanOrEqual(3);
    expect(listing.body.images).toHaveLength(1);

    const view = await agent.get(`/api/dashboard/accounts/${salon}/setup/files/${png.body.id}/file`);
    expect(view.status).toBe(200);
    expect(view.headers['content-type']).toBe('image/png');
    expect(view.headers['x-content-type-options']).toBe('nosniff');

    // ===== account isolation of files =====
    expect((await agent.get(`/api/dashboard/accounts/${disposable}/setup/files/${png.body.id}/file`)).status).toBe(404);
    expect((await agent.patch(`/api/dashboard/accounts/${disposable}/setup/files/${png.body.id}`).send({ caption: 'stolen' })).status).toBe(404);
    expect((await agent.delete(`/api/dashboard/accounts/${disposable}/setup/files/${png.body.id}`)).status).toBe(404);
    expect((await agent.get(`/api/dashboard/documents/${png.body.id}/file`).set('X-Whatsapp-Account', String(disposable))).status).toBe(404);
    expect((await agent.get(`/api/dashboard/documents/${png.body.id}/file`)).status).toBe(404); // the original business cannot read it either
    expect((await agent.get(`/api/dashboard/accounts/${disposable}/setup/files`)).body).toMatchObject({ documents: [], images: [] });
    expect((await agent.post(`/api/dashboard/accounts/${disposable}/setup/files/${pdf.body.id}/extract`)).status).toBe(404);

    const gone = await agent.delete(`/api/dashboard/accounts/${salon}/setup/files/${traversal.body.id}`);
    expect(gone.status).toBe(200);
    expect(fs.existsSync(path.join(dataDir(), 'accounts', String(salon), 'uploads', stored.stored_name))).toBe(false);
  });

  it('Analyze & Generate → review → edit → apply, using only this business\'s material', async () => {
    // some other business's material that must never appear
    await upload(disposable, 'secret.txt', Buffer.from('Services\n- SECRET-OTHER — 999 SAR'), { 'Content-Type': 'text/plain' });

    const generated = await agent.post(`/api/dashboard/accounts/${salon}/setup/generate`).send({ useAi: false });
    expect(generated.status).toBe(201);
    const draft = generated.body;
    expect(draft).toMatchObject({ status: 'draft', generator: 'rules' });
    expect(draft.content.services.map((s: { nameEn: string }) => s.nameEn)).toEqual(expect.arrayContaining(['Haircut', 'Manicure', 'Pedicure']));
    expect(draft.content.products.map((s: { nameEn: string }) => s.nameEn)).toContain('Argan shampoo');
    expect(draft.content.contact.email).toBe('hello@noor.example');
    expect(draft.content.menu.items.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining(['services', 'staff']));
    expect(draft.sources.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringMatching(/Could not read this PDF|No readable text/) })]));
    expect(JSON.stringify(draft)).not.toContain('SECRET-OTHER');
    // nothing live changed yet
    expect((await agent.get(`/api/dashboard/accounts/${salon}/setup/menu`)).body.source).toBe('default');
    expect((await agent.get('/api/dashboard/offers').set('X-Whatsapp-Account', String(salon))).body.offers).toHaveLength(0);

    // the draft belongs to this account only
    expect((await agent.get(`/api/dashboard/accounts/${disposable}/setup/drafts/${draft.id}`)).status).toBe(404);
    expect((await agent.post(`/api/dashboard/accounts/${disposable}/setup/drafts/${draft.id}/apply`).send({ mode: 'merge' })).status).toBe(404);

    // edit: rename an item, drop one, fix text — and an invalid edit is refused
    const content = structuredClone(draft.content);
    content.services.find((s: { nameEn: string }) => s.nameEn === 'Haircut').nameEn = 'Signature haircut';
    content.services.find((s: { nameEn: string }) => s.nameEn === 'Pedicure').include = false;
    const saved = await agent.put(`/api/dashboard/accounts/${salon}/setup/drafts/${draft.id}`).send({ content });
    expect(saved.status).toBe(200);
    expect(saved.body.content.services.some((s: { nameEn: string }) => s.nameEn === 'Signature haircut')).toBe(true);
    expect((await agent.put(`/api/dashboard/accounts/${salon}/setup/drafts/${draft.id}`).send({ content: { ...content, menu: { version: 1, items: [] } } })).status).toBe(400);

    // Replace needs explicit confirmation
    const noConfirm = await agent.post(`/api/dashboard/accounts/${salon}/setup/drafts/${draft.id}/apply`).send({ mode: 'replace' });
    expect(noConfirm.status).toBe(400);
    expect(noConfirm.body.error).toMatch(/confirmation/);
    expect((await agent.post(`/api/dashboard/accounts/${salon}/setup/drafts/${draft.id}/apply`).send({ mode: 'nonsense' })).status).toBe(400);

    const applied = await agent.post(`/api/dashboard/accounts/${salon}/setup/drafts/${draft.id}/apply`).send({ mode: 'merge' });
    expect(applied.status).toBe(200);
    expect(applied.body.report.mode).toBe('merge');
    expect(applied.body.report.entries.map((e: { section: string }) => e.section)).toEqual(expect.arrayContaining(['menu', 'templates', 'offers', 'knowledge']));
    expect(applied.body.draft.status).toBe('applied');
    expect((await agent.post(`/api/dashboard/accounts/${salon}/setup/drafts/${draft.id}/apply`).send({ mode: 'merge' })).status).toBe(409);

    // the edit survived into the live content
    const services = fs.readFileSync(path.join(knowledgeDirForAccount(salon), 'services.md'), 'utf8');
    expect(services).toContain('Signature haircut');
    expect(services).not.toContain('Pedicure');
    expect(services).toContain('Argan shampoo');
    // offers are drafts for staff to publish
    const offers = (await agent.get('/api/dashboard/offers').set('X-Whatsapp-Account', String(salon))).body.offers as { title_en: string; status: string }[];
    expect(offers.map((o) => o.title_en)).toContain('Weekend special');
    expect(offers.every((o) => o.status === 'draft')).toBe(true);
    // the generated menu is the one the flow map / router use for this business…
    const tree = await agent.get('/api/dashboard/menu-tree').set('X-Whatsapp-Account', String(salon));
    expect(tree.body.builtIn).toBe(false);
    expect(Object.keys(tree.body.mainMenu).length).toBeGreaterThanOrEqual(6);
    expect(tree.body.flows.appointment.fields).toEqual(['name', 'service', 'date', 'time', 'notes']);
    // …while the original business keeps its own
    const original = await agent.get('/api/dashboard/menu-tree');
    expect(original.body.builtIn).toBe(true);
    expect(original.body.flows.appointment.fields).toContain('make');
    // and its pages are editable in the existing Manual Reply Editor
    const templates = await agent.get('/api/dashboard/templates').set('X-Whatsapp-Account', String(salon));
    const keys = templates.body.templates.map((t: { key: string }) => t.key);
    expect(keys).toEqual(expect.arrayContaining(['main_menu', 'menu_services']));
    expect(templates.body.templates.find((t: { key: string }) => t.key === 'menu_services').liveEn).toContain('Signature haircut');
    expect((await agent.get('/api/dashboard/templates')).body.templates.map((t: { key: string }) => t.key)).not.toContain('menu_services');
  });

  it('the generated menu can be edited by hand and reset', async () => {
    const menu = (await agent.get(`/api/dashboard/accounts/${salon}/setup/menu`)).body;
    expect(menu.source).toBe('generated');
    const items = structuredClone(menu.config.items);
    items.push({ id: 'gifts', kind: 'info', labelEn: 'Gift cards', labelAr: 'بطاقات الهدايا' });
    const saved = await agent.put(`/api/dashboard/accounts/${salon}/setup/menu`).send({ version: 1, items: items.slice(-9) });
    expect(saved.status).toBe(200);
    expect(saved.body.source).toBe('manual');
    expect((await agent.put(`/api/dashboard/accounts/${salon}/setup/menu`).send({ version: 1, items: [] })).status).toBe(400);
    const synced = await agent.post(`/api/dashboard/accounts/${salon}/setup/menu/sync-text`);
    expect(synced.status).toBe(200);
    const main = (await agent.get(`/api/dashboard/templates/main_menu`).set('X-Whatsapp-Account', String(salon))).body;
    expect(main.liveEn).toContain('Gift cards');
    expect((await agent.get('/api/dashboard/templates').set('X-Whatsapp-Account', String(salon))).body.templates.map((t: { key: string }) => t.key)).toContain('menu_gifts');
    const reset = await agent.delete(`/api/dashboard/accounts/${salon}/setup/menu`);
    expect(reset.body.source).toBe('default');
    // the original business's menu cannot be replaced
    expect((await agent.put('/api/dashboard/accounts/1/setup/menu').send({ version: 1, items })).status).toBe(400);
  });

  it('enforces per-user access to a business on every setup route', async () => {
    // A second dashboard user (a plain admin) that may work on the original business only. The permanent Super Admin ('agent') is never restricted.
    const limitedId = Number(getDb().prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('limited-admin', hashPassword('a-very-long-test-password-123')).lastInsertRowid);
    const limited = request.agent(app);
    expect((await limited.post('/api/dashboard/auth/login').send({ username: 'limited-admin', password: 'a-very-long-test-password-123' })).status).toBe(200);
    grantAccountAccess(limitedId, 1);
    try {
      for (const [method, url] of [
        ['get', `/api/dashboard/accounts/${salon}/setup`], ['put', `/api/dashboard/accounts/${salon}/setup/profile`], ['get', `/api/dashboard/accounts/${salon}/setup/links`],
        ['get', `/api/dashboard/accounts/${salon}/setup/files`], ['post', `/api/dashboard/accounts/${salon}/setup/generate`], ['get', `/api/dashboard/accounts/${salon}/delete-preview`],
        ['delete', `/api/dashboard/accounts/${salon}`],
      ] as const) {
        const res = await limited[method](url).send({ confirm: 'DELETE' });
        expect(res.status, `${method} ${url}`).toBe(403);
      }
      expect((await limited.get('/api/dashboard/accounts/1/setup')).status).toBe(200);
    } finally {
      revokeAccountAccess(limitedId, 1);
    }
    expect((await agent.get(`/api/dashboard/accounts/${salon}/setup`)).status).toBe(200);
    expect(adminId).toBeGreaterThan(0);
  });

  it('deletes a business only after typing DELETE, removes all of its data and files, and never touches the others', async () => {
    const before = await agent.get(`/api/dashboard/accounts/${salon}/setup/files`);
    const salonDocs = before.body.documents.length;
    await upload(disposable, 'menu.txt', Buffer.from('Menu\n- Burger — 30 SAR'), { 'Content-Type': 'text/plain' });
    const authDir = path.join(dataDir(), 'accounts', String(disposable), 'baileys-auth');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{}');
    expect(fs.existsSync(path.join(dataDir(), 'accounts', String(disposable), 'uploads'))).toBe(true);

    const preview = await agent.get(`/api/dashboard/accounts/${disposable}/delete-preview`);
    expect(preview.body).toMatchObject({ name: 'Disposable Co', protected: false });
    expect(preview.body.counts.documents).toBe(2);

    expect((await agent.delete(`/api/dashboard/accounts/${disposable}`).send({})).status).toBe(400);
    const wrong = await agent.delete(`/api/dashboard/accounts/${disposable}`).send({ confirm: 'delete' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('confirmation_required');
    expect((await agent.get(`/api/dashboard/accounts/${disposable}/setup`)).status).toBe(200); // still there

    const protectedRes = await agent.delete('/api/dashboard/accounts/1').send({ confirm: 'DELETE' });
    expect(protectedRes.status).toBe(403);
    expect(protectedRes.body.code).toBe('protected');
    expect((await agent.get('/api/dashboard/accounts')).body.accounts.map((a: { id: number }) => a.id)).toContain(1);

    const deleted = await agent.delete(`/api/dashboard/accounts/${disposable}`).send({ confirm: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(deleted.body.report).toMatchObject({ name: 'Disposable Co', accountId: disposable });
    const accounts = (await agent.get('/api/dashboard/accounts')).body.accounts as { id: number; protected: boolean }[];
    expect(accounts.map((a) => a.id)).toEqual([1, salon]);
    expect(accounts.find((a) => a.id === 1)?.protected).toBe(true);
    expect(accounts.find((a) => a.id === salon)?.protected).toBe(false);
    // the browser still remembering the deleted account gets a clear 404, not another business's data
    expect((await agent.get('/api/dashboard/customers').set('X-Whatsapp-Account', String(disposable))).status).toBe(404);
    expect((await agent.get(`/api/dashboard/accounts/${disposable}/setup`)).status).toBe(404);
    expect(fs.existsSync(path.join(dataDir(), 'accounts', String(disposable)))).toBe(false);
    // the surviving business is intact
    expect((await agent.get(`/api/dashboard/accounts/${salon}/setup/files`)).body.documents).toHaveLength(salonDocs);
    expect(fs.existsSync(path.join(knowledgeDirForAccount(salon), 'services.md'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir(), 'accounts', String(salon), 'uploads'))).toBe(true);
  });
});
