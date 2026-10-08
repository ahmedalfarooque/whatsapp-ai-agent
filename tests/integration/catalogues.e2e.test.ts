import request from 'supertest';
import { describe, expect, it, beforeAll } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { setAccountFeature, FEATURES } from '../../src/accounts/accountFeatures';
import { makePdf } from '../fixtures/makePdf';

const JOTUN = 2;
const PLAIN = 3;
const a = makePdf(['Jotun Soulful Spaces', '1625 Soul']);
const b = makePdf(['Jotun Nuances 2025', 'Wonderwall Lux']);
const c = makePdf(['Jotun Brochure']);
const url = (account: number, rest = '') => `/api/dashboard/accounts/${account}/catalogues${rest}`;

describe('catalogue management API', () => {
  const app = createApp();
  const agent = request.agent(app);
  const upload = (account: number, bytes: Buffer, name: string, extra: { type?: string; title?: string } = {}) => {
    const req = agent.post(url(account)).set('Content-Type', extra.type ?? 'application/pdf').set('X-File-Name', encodeURIComponent(name));
    if (extra.title) req.set('X-Title', encodeURIComponent(extra.title));
    return req.send(bytes);
  };
  const ids: number[] = [];

  beforeAll(async () => {
    const setup = await agent.post('/api/dashboard/auth/setup').send({ username: 'catalogue-admin', password: 'a-very-long-test-password-123' });
    expect(setup.status).toBe(201);
    getDb();
    expect(createAccount({ name: 'JOTUN Rowad Alfa' }).id).toBe(JOTUN);
    expect(createAccount({ name: 'Plain Business' }).id).toBe(PLAIN);
    setAccountFeature(JOTUN, FEATURES.CATALOGUES, true);
  });

  it('requires a signed-in administrator', async () => {
    expect((await request(app).get(url(JOTUN))).status).toBe(401);
    expect((await request(app).post(url(JOTUN)).set('Content-Type', 'application/pdf').send(a)).status).toBe(401);
    expect((await request(app).delete(url(JOTUN, '/1'))).status).toBe(401);
  });

  it('does not exist for the original business or for a business without the library', async () => {
    for (const account of [1, PLAIN]) {
      expect((await agent.get(url(account))).status).toBe(404);
      expect((await upload(account, a, 'x.pdf')).status).toBe(404);
      expect((await agent.patch(url(account, '/1')).send({ enabled: false })).status).toBe(404);
      expect((await agent.delete(url(account, '/1'))).status).toBe(404);
      expect((await agent.get(url(account, '/1/file'))).status).toBe(404);
    }
    expect((await agent.get(url(99))).status).toBe(404);
  });

  it('tells the page which businesses have the tab, and offers the menu entry only to them', async () => {
    const jotun = await agent.get(`/api/dashboard/accounts/${JOTUN}/setup`);
    const plain = await agent.get(`/api/dashboard/accounts/${PLAIN}/setup`);
    const legacy = await agent.get('/api/dashboard/accounts/1/setup');
    expect(jotun.body.account.features).toEqual({ catalogues: true });
    expect(plain.body.account.features).toEqual({ catalogues: false });
    expect(legacy.body.account.features).toEqual({ catalogues: false });
    expect(jotun.body.menu.limits.kinds).toContain('catalogues');
    expect(plain.body.menu.limits.kinds).not.toContain('catalogues');
  });

  it('uploads PDFs (several, one after another) and lists them with their metadata — and never a path', async () => {
    for (const [bytes, name, title] of [[a, 'Jotun_Interiour Colors 1.pdf', 'Jotun Soulful Spaces'], [b, 'Jotun_Broucher 1.pdf', 'Jotun Nuances 2025'], [c, 'brochure.pdf', undefined]] as const) {
      const res = await upload(JOTUN, bytes, name, { title });
      expect(res.status, res.text).toBe(201);
      ids.push(res.body.id);
    }
    const list = await agent.get(url(JOTUN));
    expect(list.status).toBe(200);
    expect(list.body.catalogues.map((x: { title: string }) => x.title)).toEqual(['Jotun Soulful Spaces', 'Jotun Nuances 2025', 'brochure']);
    expect(list.body.catalogues[0]).toMatchObject({ originalName: 'Jotun_Interiour Colors 1.pdf', sizeBytes: a.length, pageCount: 1, enabled: true, hasText: true });
    expect(list.body.enabledCount).toBe(3);
    expect(list.body.customerPreview.en).toContain('1️⃣ Jotun Soulful Spaces');
    expect(list.body.customerPreview.ar).toContain('3️⃣ brochure');
    expect(JSON.stringify(list.body)).not.toMatch(/stored_name|uploads|[A-Za-z]:\\\\|"path"/);
  });

  it('refuses anything that is not a PDF', async () => {
    expect((await upload(JOTUN, a, 'notes.txt')).status).toBe(400);
    expect((await upload(JOTUN, a, 'x.pdf', { type: 'image/png' })).status).toBe(400);
    expect((await upload(JOTUN, Buffer.from('<html>no</html>'), 'x.pdf')).body.error).toMatch(/not a PDF/);
    expect((await upload(JOTUN, a, 'again.pdf')).status).toBe(409); // the same file twice
    expect((await agent.get(url(JOTUN))).body.catalogues).toHaveLength(3);
  });

  it('renames, disables/enables and reorders — and the customer preview follows', async () => {
    const [first, second, third] = ids as [number, number, number];
    expect((await agent.patch(url(JOTUN, `/${third}`)).send({ title: 'Jotun Brochure' })).body.title).toBe('Jotun Brochure');
    expect((await agent.patch(url(JOTUN, `/${third}`)).send({ title: '   ' })).status).toBe(400);
    expect((await agent.patch(url(JOTUN, `/${first}`)).send({})).status).toBe(400);
    expect((await agent.patch(url(JOTUN, `/${first}`)).send({ enabled: 'yes' })).status).toBe(400);

    const disabled = await agent.patch(url(JOTUN, `/${second}`)).send({ enabled: false });
    expect(disabled.body.enabled).toBe(false);
    let list = (await agent.get(url(JOTUN))).body;
    expect(list.enabledCount).toBe(2);
    expect(list.customerPreview.en).not.toContain('Nuances');
    expect(list.customerPreview.en).toContain('2️⃣ Jotun Brochure');
    await agent.patch(url(JOTUN, `/${second}`)).send({ enabled: true });

    expect((await agent.post(url(JOTUN, `/${third}/move`)).send({ direction: 'up' })).body.catalogues.map((x: { id: number }) => x.id)).toEqual([first, third, second]);
    expect((await agent.post(url(JOTUN, `/${third}/move`)).send({ direction: 'sideways' })).status).toBe(400);
    expect((await agent.put(url(JOTUN, '/order')).send({ ids: [second, first, third] })).body.catalogues.map((x: { id: number }) => x.id)).toEqual([second, first, third]);
    expect((await agent.put(url(JOTUN, '/order')).send({ ids: [first] })).status).toBe(400);
    list = (await agent.get(url(JOTUN))).body;
    expect(list.customerPreview.en).toContain('1️⃣ Jotun Nuances 2025');
  });

  it('serves the original bytes for preview and download, only for this business', async () => {
    const [first] = ids as [number];
    const inline = await agent.get(url(JOTUN, `/${first}/file`)).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (d: Buffer) => chunks.push(d)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(inline.status).toBe(200);
    expect(inline.headers['content-type']).toMatch(/application\/pdf/);
    expect(inline.headers['content-disposition']).toMatch(/^inline/);
    expect((inline.body as Buffer).equals(a)).toBe(true);
    expect((await agent.get(url(JOTUN, `/${first}/file?download=1`))).headers['content-disposition']).toMatch(/^attachment/);
    expect((await agent.get(url(JOTUN, '/99999/file'))).status).toBe(404);
    expect((await agent.get(url(PLAIN, `/${first}/file`))).status).toBe(404);
    expect((await agent.get(url(1, `/${first}/file`))).status).toBe(404);
  });

  it('replaces a file while keeping the catalogue, then deletes it for good', async () => {
    const [, , third] = ids as [number, number, number];
    const replaced = await agent.put(url(JOTUN, `/${third}/file`)).set('Content-Type', 'application/pdf').set('X-File-Name', encodeURIComponent('brochure-2026.pdf')).send(makePdf(['Jotun Brochure 2026']));
    expect(replaced.status, replaced.text).toBe(200);
    expect(replaced.body).toMatchObject({ id: third, title: 'Jotun Brochure', originalName: 'brochure-2026.pdf' });
    expect((await agent.put(url(JOTUN, `/${third}/file`)).set('Content-Type', 'text/plain').set('X-File-Name', 'x.txt').send('nope')).status).toBe(400);

    expect((await agent.delete(url(JOTUN, `/${third}`))).body).toEqual({ ok: true });
    expect((await agent.get(url(JOTUN))).body.catalogues.map((x: { id: number }) => x.id)).not.toContain(third);
    expect((await agent.get(url(JOTUN, `/${third}/file`))).status).toBe(404);
    expect((await agent.delete(url(JOTUN, `/${third}`))).status).toBe(404);
  });
});
