import fs from 'node:fs';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createAccount, grantAccountAccess, revokeAccountAccess, setAccountEnabled } from '../../src/accounts/accountRepo';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';
import { updateBusinessSettings } from '../../src/config/businessSettings';
import { documentPath, saveDocument } from '../../src/documents/documentStore';
import { resolveBranding } from '../../src/dashboard/branding';
import { getAuthUser } from '../../src/dashboard/permissions';
import { runWithAccount } from '../../src/accounts/accountContext';
import { TINY_PNG } from '../fixtures/makePdf';

const OWNER = 'owner@example.com';
const PASSWORD = 'a-very-long-test-password-123';

describe('who the interface is for: branding decided on the server from the real account assignments', () => {
  const app = createApp();
  let ROWAD: number; // the original business (account 1)
  let JOTUN: number;
  let QMULATE: number;
  let ownerId: number;
  const user: Record<string, number> = {};
  const as = (userId: number) => {
    const cookie = `${SESSION_COOKIE_NAME}=${createSession(userId).token}`;
    const get = (url: string, account?: number) => {
      const r = request(app).get(url).set('Cookie', cookie).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
      return account ? r.set('X-Whatsapp-Account', String(account)) : r;
    };
    const me = async (account?: number) => {
      const res = await request(app).get('/api/dashboard/me').set('Cookie', cookie).set(...(account ? ['X-Whatsapp-Account', String(account)] as [string, string] : ['X-Test', '1'] as [string, string]));
      return res;
    };
    return { get, me };
  };
  const json = (res: { body: unknown }) => JSON.parse((res.body as Buffer).toString('utf8'));

  async function makeUser(key: string, body: Record<string, unknown>): Promise<void> {
    const res = await request(app).post('/api/dashboard/users').set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(ownerId).token}`).send({ password: PASSWORD, email: `${key}@example.com`, ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    user[key] = res.body.id;
  }

  beforeAll(async () => {
    getDb();
    expect((await request(app).post('/api/dashboard/auth/setup').send({ username: OWNER, password: PASSWORD })).status).toBe(201);
    ownerId = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get(OWNER) as { id: number }).id;
    ROWAD = 1;
    getDb().prepare("UPDATE whatsapp_accounts SET name = 'Rowad Alfa Auto Care', name_ar = 'شركة رواد ألفا للعناية بالسيارات' WHERE id = 1").run();
    JOTUN = createAccount({ name: 'JOTUN Rowad Alfa', nameAr: 'جوتن رواد الفا' }).id;
    QMULATE = createAccount({ name: 'QMULATE Real Estate Consultancy', nameAr: 'QMULATE للاستشارات العقارية' }).id;
    // QMULATE has its own verified logo document; Rowad Alfa uses the bundled one; JOTUN has none
    const logo = saveDocument({ originalName: 'logo.png', mimeType: 'image/png', bytes: TINY_PNG, visibility: 'internal', title: 'QMULATE logo', accountId: QMULATE, purpose: 'logo' });
    runWithAccount(QMULATE, () => updateBusinessSettings({ logoDocumentId: logo.id }));
    await makeUser('rowad', { role: 'manager', accountIds: [ROWAD] });
    await makeUser('jotun', { role: 'manager', accountIds: [JOTUN] });
    await makeUser('qmulate', { role: 'user', accountIds: [QMULATE] });
    await makeUser('both', { role: 'manager', accountIds: [JOTUN, QMULATE] });
    await makeUser('all', { role: 'admin', allAccounts: true });
    await makeUser('nobody', { role: 'manager', accountIds: [JOTUN] });
    revokeAccountAccess(user.nobody!, JOTUN); // an account list that ended up empty
  });

  it('Super Admin gets the SynrTech Studio (developer) branding, and so does a user granted every account', async () => {
    for (const id of [ownerId, user.all!]) {
      const res = await as(id).me();
      expect(res.status).toBe(200);
      expect(res.body.branding).toEqual({ mode: 'developer', company: null });
    }
    expect((await as(ownerId).me()).body.superAdmin).toBe(true);
  });

  it('a regular user with exactly one account gets that company: its name, Arabic name and verified logo', async () => {
    const rowad = (await as(user.rowad!).me()).body.branding;
    expect(rowad).toMatchObject({ mode: 'company', company: { accountId: ROWAD, name: 'Rowad Alfa Auto Care', nameAr: 'شركة رواد ألفا للعناية بالسيارات', logoUrl: '/dashboard/assets/logo.webp' } });
    const jotun = (await as(user.jotun!).me()).body.branding;
    expect(jotun).toMatchObject({ mode: 'company', company: { accountId: JOTUN, name: 'JOTUN Rowad Alfa', nameAr: 'جوتن رواد الفا', logoUrl: null } }); // no verified logo: a neutral tile, never another company's logo
    const q = (await as(user.qmulate!).me()).body.branding;
    expect(q).toMatchObject({ mode: 'company', company: { accountId: QMULATE, name: 'QMULATE Real Estate Consultancy', nameAr: 'QMULATE للاستشارات العقارية' } });
    expect(q.company.logoUrl).toMatch(/^\/api\/dashboard\/branding\/logo\?v=\d+-\d+$/);
  });

  it('serves the company logo only to its own signed-in user, as the stored bytes, with safe headers', async () => {
    const res = await as(user.qmulate!).get('/api/dashboard/branding/logo');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toContain('private');
    expect((res.body as Buffer).equals(TINY_PNG)).toBe(true);
    expect((await request(app).get('/api/dashboard/branding/logo')).status).toBe(401);
    // a company without a stored logo has none to fetch; developer-branded users never get a company logo
    expect((await as(user.jotun!).get('/api/dashboard/branding/logo')).status).toBe(404);
    expect((await as(user.both!).get('/api/dashboard/branding/logo')).status).toBe(404);
    expect((await as(ownerId).get('/api/dashboard/branding/logo')).status).toBe(404);
  });

  it('several accounts, or none, or an unclear assignment resolve to SynrTech Studio — never to a guessed company', async () => {
    expect((await as(user.both!).me()).body.branding).toEqual({ mode: 'developer', company: null });
    // no assigned account at all: the server refuses the session's dashboard calls (fails closed) and offers no company identity
    const nobody = await as(user.nobody!).me();
    expect(nobody.status).toBe(403);
    expect(JSON.stringify(nobody.body)).not.toMatch(/JOTUN|QMULATE|Rowad/);
    expect((await as(user.nobody!).get('/api/dashboard/branding/logo')).status).toBe(403);
    expect(resolveBranding(getAuthUser(user.nobody!))).toEqual({ mode: 'developer', company: null });
    expect(resolveBranding(null)).toEqual({ mode: 'developer', company: null });
  });

  it('cannot be forced: not by a header, a query parameter or an account id; another company\'s data stays unreachable', async () => {
    const jotun = as(user.jotun!);
    // asking for another business is refused outright
    const other = await jotun.me(QMULATE);
    expect(other.status).toBe(403);
    expect(JSON.stringify(other.body)).not.toContain('QMULATE');
    expect((await jotun.get('/api/dashboard/branding/logo', QMULATE)).status).toBe(403);
    expect((await jotun.get('/api/dashboard/customers/directory', QMULATE)).status).toBe(403);
    expect((await jotun.get('/api/dashboard/customers/directory?account=' + QMULATE)).status).toBe(403);
    // branding hints in the query string change nothing
    const cookie = `${SESSION_COOKIE_NAME}=${createSession(user.jotun!).token}`;
    const hinted = await request(app).get(`/api/dashboard/me?branding=company&company=${QMULATE}&brand=${QMULATE}`).set('Cookie', cookie);
    expect(hinted.body.branding.company.accountId).toBe(JOTUN);
    expect(hinted.body.branding.company.name).toBe('JOTUN Rowad Alfa');
    // a user never learns another company's name through the accounts list either
    const list = json(await jotun.get('/api/dashboard/accounts'));
    expect(list.accounts.map((a: { id: number }) => a.id)).toEqual([JOTUN]);
  });

  it('a logo document of another business is never used: the lookup is scoped to the account that owns the setting', async () => {
    const foreign = saveDocument({ originalName: 'other.png', mimeType: 'image/png', bytes: TINY_PNG, visibility: 'internal', title: 'foreign', accountId: QMULATE, purpose: 'logo' });
    getDb().prepare('UPDATE business_settings SET logo_document_id = ? WHERE id = ?').run(foreign.id, JOTUN);
    expect((await as(user.jotun!).me()).body.branding.company.logoUrl).toBeNull();
    expect((await as(user.jotun!).get('/api/dashboard/branding/logo')).status).toBe(404);
    getDb().prepare('UPDATE business_settings SET logo_document_id = NULL WHERE id = ?').run(JOTUN);
  });

  it('a missing, archived or oversized logo falls back to the neutral tile instead of failing', async () => {
    const logo = saveDocument({ originalName: 'logo.png', mimeType: 'image/png', bytes: TINY_PNG, visibility: 'internal', title: 'JOTUN logo', accountId: JOTUN, purpose: 'logo' });
    runWithAccount(JOTUN, () => updateBusinessSettings({ logoDocumentId: logo.id }));
    expect((await as(user.jotun!).me()).body.branding.company.logoUrl).toMatch(/branding\/logo/);
    // archived
    getDb().prepare("UPDATE business_documents SET status = 'archived' WHERE id = ?").run(logo.id);
    expect((await as(user.jotun!).me()).body.branding.company.logoUrl).toBeNull();
    getDb().prepare("UPDATE business_documents SET status = 'active' WHERE id = ?").run(logo.id);
    // oversized
    getDb().prepare('UPDATE business_documents SET size_bytes = ? WHERE id = ?').run(5 * 1024 * 1024, logo.id);
    expect((await as(user.jotun!).me()).body.branding.company.logoUrl).toBeNull();
    getDb().prepare('UPDATE business_documents SET size_bytes = ? WHERE id = ?').run(TINY_PNG.length, logo.id);
    // file gone from disk
    fs.rmSync(documentPath(runWithAccount(JOTUN, () => getDb().prepare('SELECT * FROM business_documents WHERE id = ?').get(logo.id)) as never), { force: true });
    const me = await as(user.jotun!).me();
    expect(me.status).toBe(200);
    expect(me.body.branding.company.logoUrl).toBeNull();
    expect((await as(user.jotun!).get('/api/dashboard/branding/logo')).status).toBe(404);
  });

  it('follows the assignments as they change: no stale company after access is granted, revoked or the account is disabled', async () => {
    const who = user.qmulate!;
    expect((await as(who).me()).body.branding.mode).toBe('company');
    grantAccountAccess(who, JOTUN, 'user'); // now two accounts: the company identity goes away at once
    expect((await as(who).me()).body.branding).toEqual({ mode: 'developer', company: null });
    expect((await as(who).get('/api/dashboard/branding/logo')).status).toBe(404);
    revokeAccountAccess(who, JOTUN);
    expect((await as(who).me()).body.branding.company.accountId).toBe(QMULATE);
    setAccountEnabled(QMULATE, false); // a disabled account is not a branding source
    expect((await as(who).me()).body.branding).toEqual({ mode: 'developer', company: null });
    setAccountEnabled(QMULATE, true);
    revokeAccountAccess(who, QMULATE); // everything revoked: the session can no longer read anything
    const gone = await as(who).me();
    expect(gone.status).toBe(403);
    expect(JSON.stringify(gone.body)).not.toContain('QMULATE');
    grantAccountAccess(who, QMULATE, 'user');
  });

  it('a disabled user is not branded and cannot read anything; an anonymous caller gets 401', async () => {
    expect((await request(app).get('/api/dashboard/me')).status).toBe(401);
    expect(resolveBranding({ ...getAuthUser(user.rowad!)!, disabled: true })).toEqual({ mode: 'developer', company: null });
  });

  it('the dashboard still treats the branding as display only: permissions are exactly what they were', async () => {
    const me = (await as(user.qmulate!).me()).body;
    expect(me.permissions.customers).toBe('view'); // the "user" preset: view only, unchanged by being company-branded
    expect((await request(app).post('/api/dashboard/customers/1/notes').set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(user.qmulate!).token}`).send({ body: 'x' })).status).toBe(403);
  });
});
