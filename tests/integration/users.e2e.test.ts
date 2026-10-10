import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { saveDocument } from '../../src/documents/documentStore';
import { createOffer } from '../../src/offers/offerRepo';
import { createSession, verifyPassword } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';

/**
 * Users, roles and per-account permissions, through the real HTTP API.
 * Sessions are created directly (createSession) so the sign-in rate limiter is not what is being exercised; the sign-in tests
 * use the real /auth/login endpoint.
 */
const OWNER = 'owner@example.com';
const OWNER_PASSWORD = 'owner-password-very-long-123';
const PASSWORD = 'a-very-long-test-password-123';

describe('dashboard users, roles and permissions', () => {
  const app = createApp();
  let ownerId: number;
  let second: number; // WhatsApp account 2
  const ids: Record<string, number> = {};

  /** A client that is signed in as the given user id (a real session cookie). */
  const as = (userId: number) => {
    const cookie = `${SESSION_COOKIE_NAME}=${createSession(userId).token}`;
    const call = (method: 'get' | 'post' | 'put' | 'delete', url: string, account?: number) => {
      const r = request(app)[method](url).set('Cookie', cookie);
      return account ? r.set('X-Whatsapp-Account', String(account)) : r;
    };
    return {
      get: (url: string, account?: number) => call('get', url, account),
      post: (url: string, account?: number) => call('post', url, account),
      put: (url: string, account?: number) => call('put', url, account),
      delete: (url: string, account?: number) => call('delete', url, account),
    };
  };
  let owner: ReturnType<typeof as>;

  async function create(body: Record<string, unknown>, by: ReturnType<typeof as> = owner) {
    return by.post('/api/dashboard/users').send({ password: PASSWORD, ...body });
  }

  beforeAll(async () => {
    getDb();
    const setup = await request(app).post('/api/dashboard/auth/setup').send({ username: OWNER, password: OWNER_PASSWORD });
    expect(setup.status).toBe(201);
    ownerId = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get(OWNER) as { id: number }).id;
    owner = as(ownerId);
    second = createAccount({ name: 'JOTUN Test' }).id;

    const one = await create({ email: 'alice@example.com', name: 'Alice', role: 'manager', accountIds: [1] });
    const two = await create({ email: 'bob@example.com', name: 'Bob', role: 'user', accountIds: [second] });
    const both = await create({ email: 'carol@example.com', role: 'manager', accountIds: [1, second] });
    const custom = await create({ email: 'dave@example.com', role: 'custom', accountIds: [1], permissions: { 1: { offers: 'edit', conversations: 'view' } } });
    const admin = await create({ email: 'erin@example.com', role: 'admin', accountIds: [1, second] });
    for (const r of [one, two, both, custom, admin]) expect(r.status, JSON.stringify(r.body)).toBe(201);
    Object.assign(ids, { alice: one.body.id, bob: two.body.id, carol: both.body.id, dave: custom.body.id, erin: admin.body.id });
  });

  describe('the permanent Super Admin', () => {
    it('is the account created by first-time setup, protected, with every account and capability', async () => {
      const me = await owner.get('/api/dashboard/me');
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ role: 'super_admin', protected: true, superAdmin: true, allAccounts: true, capabilities: { connection: true, configuration: true, users: true } });
    });

    it('cannot be disabled, edited, downgraded, re-assigned or have its password reset — by an admin or by itself', async () => {
      const admin = as(ids.erin!);
      for (const actor of [admin, owner]) {
        expect((await actor.post(`/api/dashboard/users/${ownerId}/disable`)).status).toBe(403);
        expect((await actor.put(`/api/dashboard/users/${ownerId}`).send({ role: 'user', accountIds: [1] })).status).toBe(403);
        expect((await actor.post(`/api/dashboard/users/${ownerId}/reset-password`).send({ password: 'another-long-password-1' })).status).toBe(403);
        expect((await actor.post(`/api/dashboard/users/${ownerId}/revoke-sessions`)).status).toBe(403);
      }
      const row = getDb().prepare('SELECT role, is_protected, disabled_at, all_accounts FROM admin_users WHERE id = ?').get(ownerId);
      expect(row).toMatchObject({ role: 'super_admin', is_protected: 1, disabled_at: null, all_accounts: 1 });
    });

    it('keeps its password: it still signs in with the original credentials', async () => {
      const login = await request(app).post('/api/dashboard/auth/login').send({ username: OWNER, password: OWNER_PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.ok).toBe(true);
    });

    it('nobody can create another Super Admin or promote themselves', async () => {
      expect((await create({ email: 'x1@example.com', role: 'super_admin', accountIds: [1] })).status).toBe(400);
      expect((await as(ids.alice!).put(`/api/dashboard/users/${ids.alice}`).send({ role: 'admin' })).status).toBe(403);
      expect((await as(ids.erin!).put(`/api/dashboard/users/${ids.erin}`).send({ role: 'super_admin' })).status).toBe(403);
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM admin_users WHERE role = 'super_admin'").get()).toEqual({ n: 1 });
    });

    it('keeps access to every account even if account rows are written for it', async () => {
      getDb().prepare('INSERT INTO admin_account_access (admin_user_id, whatsapp_account_id) VALUES (?, ?)').run(ownerId, second);
      try {
        expect((await owner.get('/api/dashboard/customers', 1)).status).toBe(200);
        expect((await owner.get('/api/dashboard/customers', second)).status).toBe(200);
      } finally {
        getDb().prepare('DELETE FROM admin_account_access WHERE admin_user_id = ?').run(ownerId);
      }
    });
  });

  describe('creating users', () => {
    it('stores a scrypt hash — never the password — and never returns one', async () => {
      const created = await create({ email: 'frank@example.com', name: 'Frank', role: 'user', accountIds: [1] });
      expect(created.status).toBe(201);
      expect(JSON.stringify(created.body)).not.toMatch(/password|hash|scrypt/i);
      const row = getDb().prepare('SELECT password_hash FROM admin_users WHERE username = ?').get('frank@example.com') as { password_hash: string };
      expect(row.password_hash.startsWith('scrypt$')).toBe(true);
      expect(row.password_hash).not.toContain(PASSWORD);
      expect(verifyPassword(PASSWORD, row.password_hash)).toBe(true);
      const list = await owner.get('/api/dashboard/users?search=frank');
      expect(JSON.stringify(list.body)).not.toMatch(/password|scrypt/i);
    });

    it('rejects duplicate emails (any letter case), bad emails, short passwords and unknown roles or accounts', async () => {
      expect((await create({ email: 'ALICE@example.com', role: 'user', accountIds: [1] })).status).toBe(409);
      expect((await create({ email: OWNER.toUpperCase(), role: 'user', accountIds: [1] })).status).toBe(409);
      const badEmail = await create({ email: 'not-an-email', role: 'user', accountIds: [1] });
      expect(badEmail.status).toBe(400);
      expect(badEmail.body.fields.email).toBeTruthy();
      const short = await create({ email: 'short@example.com', password: 'tooshort', role: 'user', accountIds: [1] });
      expect(short.status).toBe(400);
      expect(short.body.fields.password).toBeTruthy();
      expect((await create({ email: 'r@example.com', role: 'wizard', accountIds: [1] })).status).toBe(400);
      expect((await create({ email: 'n@example.com', role: 'user', accountIds: [999] })).status).toBe(400);
      expect((await create({ email: 'e@example.com', role: 'user', accountIds: [] })).status).toBe(400); // no account = no access, so it is refused
    });

    it('a created user signs in with exactly the email and password the administrator set, and wrong credentials are rejected', async () => {
      const good = await request(app).post('/api/dashboard/auth/login').send({ username: 'alice@example.com', password: PASSWORD });
      expect(good.status).toBe(200);
      expect(String(good.headers['set-cookie'])).toContain(SESSION_COOKIE_NAME);
      const bad = await request(app).post('/api/dashboard/auth/login').send({ username: 'alice@example.com', password: `${PASSWORD}x` });
      expect(bad.status).toBe(401);
      expect((await request(app).post('/api/dashboard/auth/login').send({ username: 'nobody@example.com', password: PASSWORD })).status).toBe(401);
    });
  });

  describe('who may manage users', () => {
    it('managers, users and custom users cannot list, create or change users', async () => {
      for (const who of [ids.alice!, ids.bob!, ids.dave!]) {
        const c = as(who);
        expect((await c.get('/api/dashboard/users')).status).toBe(403);
        expect((await c.get('/api/dashboard/users/meta')).status).toBe(403);
        expect((await create({ email: `evil${who}@example.com`, role: 'user', accountIds: [1] }, c)).status).toBe(403);
        expect((await c.put(`/api/dashboard/users/${ids.bob}`).send({ role: 'admin' })).status).toBe(403);
        expect((await c.post(`/api/dashboard/users/${ids.bob}/disable`)).status).toBe(403);
      }
    });

    it('an unauthenticated caller gets 401', async () => {
      expect((await request(app).get('/api/dashboard/users')).status).toBe(401);
      expect((await request(app).post('/api/dashboard/users').send({})).status).toBe(401);
    });

    it('an admin can create managers and users, but not admins, and cannot manage another admin', async () => {
      const admin = as(ids.erin!);
      expect((await create({ email: 'g@example.com', role: 'manager', accountIds: [1] }, admin)).status).toBe(201);
      expect((await create({ email: 'h@example.com', role: 'admin', accountIds: [1] }, admin)).status).toBe(403);
      expect((await create({ email: 'i@example.com', role: 'user', accountIds: [1], allAccounts: true }, admin)).status).toBe(403);
      const other = await create({ email: 'erin2@example.com', role: 'admin', accountIds: [1] });
      expect(other.status).toBe(201);
      expect((await admin.post(`/api/dashboard/users/${other.body.id}/disable`)).status).toBe(403);
      expect((await admin.put(`/api/dashboard/users/${other.body.id}`).send({ name: 'x' })).status).toBe(403);
      expect((await admin.post(`/api/dashboard/users/${ids.erin}/disable`)).status).toBe(403); // nobody changes their own status
    });

    it('an admin may only hand out accounts it can open itself', async () => {
      const restrictedAdmin = await create({ email: 'ruth@example.com', role: 'admin', accountIds: [1] });
      expect(restrictedAdmin.status).toBe(201);
      const c = as(restrictedAdmin.body.id);
      expect((await create({ email: 'j@example.com', role: 'user', accountIds: [second] }, c)).status).toBe(403);
      expect((await create({ email: 'k@example.com', role: 'user', accountIds: [1] }, c)).status).toBe(201);
      expect((await c.get('/api/dashboard/users/meta')).body.accounts.map((a: { id: number }) => a.id)).toEqual([1]);
    });

    it('only the Super Admin can give an administrator connection or configuration access', async () => {
      expect((await create({ email: 'l@example.com', role: 'admin', accountIds: [1], canConnection: true }, as(ids.erin!))).status).toBe(403);
      const granted = await create({ email: 'm@example.com', role: 'admin', accountIds: [1], canConnection: true });
      expect(granted.status).toBe(201);
      expect(granted.body.canConnection).toBe(true);
      expect((await create({ email: 'n2@example.com', role: 'manager', accountIds: [1], canConfiguration: true })).status).toBe(403);
    });
  });

  describe('disabling and password resets', () => {
    it('a disabled user cannot sign in and an existing session stops working immediately; re-enabling restores access', async () => {
      const made = await create({ email: 'gina@example.com', role: 'user', accountIds: [1] });
      const gina = as(made.body.id);
      expect((await gina.get('/api/dashboard/me')).status).toBe(200);
      const disabled = await owner.post(`/api/dashboard/users/${made.body.id}/disable`);
      expect(disabled.status).toBe(200);
      expect(disabled.body.status).toBe('disabled');
      expect((await gina.get('/api/dashboard/me')).status).toBe(401);
      expect((await request(app).post('/api/dashboard/auth/login').send({ username: 'gina@example.com', password: PASSWORD })).status).toBe(401);
      expect((await owner.post(`/api/dashboard/users/${made.body.id}/enable`)).body.status).toBe('active');
      expect((await request(app).post('/api/dashboard/auth/login').send({ username: 'gina@example.com', password: PASSWORD })).status).toBe(200);
    });

    it('resetting a password signs the user out and the new password works, the old one does not', async () => {
      const made = await create({ email: 'hank@example.com', role: 'user', accountIds: [1] });
      const hank = as(made.body.id);
      expect((await hank.get('/api/dashboard/me')).status).toBe(200);
      expect((await owner.post(`/api/dashboard/users/${made.body.id}/reset-password`).send({ password: 'short' })).status).toBe(400);
      const reset = await owner.post(`/api/dashboard/users/${made.body.id}/reset-password`).send({ password: 'a-brand-new-long-password-9' });
      expect(reset.status).toBe(200);
      expect(JSON.stringify(reset.body)).not.toContain('a-brand-new');
      expect((await hank.get('/api/dashboard/me')).status).toBe(401);
      expect((await request(app).post('/api/dashboard/auth/login').send({ username: 'hank@example.com', password: PASSWORD })).status).toBe(401);
      expect((await request(app).post('/api/dashboard/auth/login').send({ username: 'hank@example.com', password: 'a-brand-new-long-password-9' })).status).toBe(200);
    });

    it('changing a user\'s access signs them out; audit entries never contain passwords', async () => {
      const made = await create({ email: 'ivy@example.com', role: 'user', accountIds: [1] });
      const ivy = as(made.body.id);
      expect((await ivy.get('/api/dashboard/me')).status).toBe(200);
      const updated = await owner.put(`/api/dashboard/users/${made.body.id}`).send({ accountIds: [second] });
      expect(updated.status).toBe(200);
      expect(updated.body.accounts.map((a: { id: number }) => a.id)).toEqual([second]);
      expect((await ivy.get('/api/dashboard/me')).status).toBe(401);
      const log = getDb().prepare('SELECT detail FROM admin_audit_log').all() as { detail: string | null }[];
      expect(log.length).toBeGreaterThan(5);
      expect(JSON.stringify(log)).not.toContain(PASSWORD);
    });
  });

  describe('WhatsApp account isolation (enforced by the server)', () => {
    it('a user assigned account 1 cannot reach account 2 by header, by path, by query string or by guessing ids', async () => {
      const alice = as(ids.alice!);
      expect((await alice.get('/api/dashboard/customers', 1)).status).toBe(200);
      expect((await alice.get('/api/dashboard/customers', second)).status).toBe(403);
      expect((await alice.get(`/api/dashboard/customers?account=${second}`)).status).toBe(403);
      expect((await alice.get(`/api/dashboard/accounts/${second}`)).status).toBe(403);
      expect((await alice.get(`/api/dashboard/accounts/${second}/setup`)).status).toBe(403);
      expect((await alice.get(`/api/dashboard/accounts/${second}/catalogues`)).status).toBe(403);
      expect((await alice.get('/api/dashboard/customers', 9999)).status).toBe(404);
    });

    it('a user assigned account 2 cannot reach account 1, and lands on their own account without a header', async () => {
      const bob = as(ids.bob!);
      expect((await bob.get('/api/dashboard/customers', 1)).status).toBe(403);
      expect((await bob.get('/api/dashboard/customers', second)).status).toBe(200);
      const me = await bob.get('/api/dashboard/me');
      expect(me.body.accountIds).toEqual([second]);
      const accounts = await bob.get('/api/dashboard/accounts');
      expect(accounts.body.accounts.map((a: { id: number }) => a.id)).toEqual([second]);
      expect(accounts.body.selected).toBe(second);
    });

    it('a user assigned both accounts can use both, and sees both in the switcher', async () => {
      const carol = as(ids.carol!);
      expect((await carol.get('/api/dashboard/customers', 1)).status).toBe(200);
      expect((await carol.get('/api/dashboard/customers', second)).status).toBe(200);
      expect((await carol.get('/api/dashboard/accounts')).body.accounts.map((a: { id: number }) => a.id).sort()).toEqual([1, second].sort());
    });

    it('documents and files of another account are not downloadable, listable or visible', async () => {
      const doc = saveDocument({ originalName: 'secret.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.4 account-one-secret'), visibility: 'customer', accountId: 1 });
      const bob = as(ids.bob!);
      expect((await bob.get(`/api/dashboard/documents/${doc.id}/file`, 1)).status).toBe(403);
      const otherAccountView = await bob.get(`/api/dashboard/documents/${doc.id}/file`, second);
      expect(otherAccountView.status).toBe(404);
      expect(JSON.stringify((await bob.get('/api/dashboard/documents', second)).body)).not.toContain('secret.pdf');
      // control: a manager of account 1 (documents included in the preset) can download it
      expect((await as(ids.alice!).get(`/api/dashboard/documents/${doc.id}/file`, 1)).status).toBe(200);
    });

    it('offers of another account never appear in a restricted user\'s lists', async () => {
      createOffer({ titleAr: 'عرض', titleEn: 'ACCOUNT-ONE-ONLY-OFFER' }, 'test', undefined, 1);
      const bob = as(ids.bob!);
      expect(JSON.stringify((await bob.get('/api/dashboard/offers', second)).body)).not.toContain('ACCOUNT-ONE-ONLY-OFFER');
    });
  });

  describe('feature permissions (view / edit / manage) — checked on the server', () => {
    it('a view-only user can read but every write is refused, even when the API is called directly', async () => {
      const bob = as(ids.bob!); // role "user": view on offers, documents, requests, ...
      expect((await bob.get('/api/dashboard/offers', second)).status).toBe(200);
      expect((await bob.post('/api/dashboard/offers', second).send({ titleAr: 'ع', titleEn: 'Blocked' })).status).toBe(403);
      expect((await bob.put('/api/dashboard/offers/1', second).send({ titleAr: 'ع', titleEn: 'x' })).status).toBe(403);
      expect((await bob.delete('/api/dashboard/offers/1', second)).status).toBe(403);
      expect((await bob.post('/api/dashboard/customers/1/pause', second)).status).toBe(403);
      expect((await bob.post('/api/dashboard/notifications/flush', second)).status).toBe(403);
      expect((await bob.put('/api/dashboard/automation', second)).status).toBe(403);
    });

    it('a user has no access to features outside the role preset (business profile, menus, AI settings)', async () => {
      const bob = as(ids.bob!);
      expect((await bob.get('/api/dashboard/business-profile', second)).status).toBe(403);
      expect((await bob.get('/api/dashboard/templates', second)).status).toBe(403);
      expect((await bob.get('/api/dashboard/knowledge', second)).status).toBe(403);
      expect((await bob.get('/api/dashboard/ai', second)).status).toBe(403);
    });

    it('a manager can read and edit operational features but cannot delete (manage) them', async () => {
      const alice = as(ids.alice!);
      expect((await alice.get('/api/dashboard/offers', 1)).status).toBe(200);
      const made = await alice.post('/api/dashboard/offers', 1).send({ titleAr: 'عرض', titleEn: 'Manager offer' });
      expect(made.status).toBe(201);
      expect((await alice.put(`/api/dashboard/offers/${made.body.id}`, 1).send({ titleAr: 'عرض', titleEn: 'Manager offer v2' })).status).toBe(200);
      expect((await alice.delete(`/api/dashboard/offers/${made.body.id}`, 1)).status).toBe(403);
      expect((await owner.delete(`/api/dashboard/offers/${made.body.id}`, 1)).status).toBe(200);
    });

    it('a custom user gets exactly the permissions selected', async () => {
      const dave = as(ids.dave!);
      expect((await dave.get('/api/dashboard/conversations', 1)).status).toBe(200);
      expect((await dave.get('/api/dashboard/offers', 1)).status).toBe(200);
      expect((await dave.post('/api/dashboard/offers', 1).send({ titleAr: 'عرض', titleEn: 'Custom offer' })).status).toBe(201);
      expect((await dave.get('/api/dashboard/customers', 1)).status).toBe(403); // not selected
      expect((await dave.get('/api/dashboard/documents', 1)).status).toBe(403);
      const me = (await dave.get('/api/dashboard/me', 1)).body;
      expect(me.permissions).toEqual({ offers: 'edit', conversations: 'view' });
    });

    it('permissions are per account: the same user can hold different levels on different accounts', async () => {
      const made = await create({ email: 'zed@example.com', role: 'custom', accountIds: [1, second], permissions: { 1: { offers: 'edit' }, [second]: { offers: 'view' } } });
      const zed = as(made.body.id);
      expect((await zed.post('/api/dashboard/offers', 1).send({ titleAr: 'ع', titleEn: 'Zed one' })).status).toBe(201);
      expect((await zed.post('/api/dashboard/offers', second).send({ titleAr: 'ع', titleEn: 'Zed two' })).status).toBe(403);
      expect((await zed.get('/api/dashboard/offers', second)).status).toBe(200);
    });

    it('an unknown API route is closed to everyone except the Super Admin (deny by default)', async () => {
      expect((await as(ids.alice!).get('/api/dashboard/some-new-route', 1)).status).toBe(403);
      expect((await as(ids.erin!).get('/api/dashboard/some-new-route', 1)).status).toBe(403);
      expect((await owner.get('/api/dashboard/some-new-route', 1)).status).toBe(404);
    });
  });

  describe('WhatsApp connection and sensitive configuration', () => {
    const connectionRoutes = [
      ['get', '/api/dashboard/whatsapp/qr'], ['post', '/api/dashboard/whatsapp/qr/connect'], ['get', '/api/dashboard/whatsapp/status'], ['post', '/api/dashboard/whatsapp/configure'],
      ['get', '/api/dashboard/accounts/1/qr'], ['post', '/api/dashboard/accounts/1/qr/connect'], ['post', '/api/dashboard/accounts/1/qr/disconnect'],
      ['post', '/api/dashboard/accounts'], ['put', '/api/dashboard/accounts/1'], ['post', '/api/dashboard/accounts/1/disable'], ['get', '/api/dashboard/webhook-info'],
      ['get', '/api/dashboard/accounts/1/delete-preview'], ['delete', '/api/dashboard/accounts/1'],
    ] as const;
    const configurationRoutes = [
      ['get', '/api/dashboard/credentials'], ['put', '/api/dashboard/credentials/OPENROUTER_API_KEY'], ['get', '/api/dashboard/integrations'], ['post', '/api/dashboard/ai/configure'],
      ['get', '/api/dashboard/system'], ['get', '/api/dashboard/settings'], ['put', '/api/dashboard/settings'], ['get', '/api/dashboard/project-sync'],
    ] as const;

    it('managers, users, custom users and admins without the grant are refused on every connection and configuration route', async () => {
      for (const who of [ids.alice!, ids.bob!, ids.dave!, ids.erin!]) {
        const c = as(who);
        for (const [method, url] of [...connectionRoutes, ...configurationRoutes]) {
          const res = await c[method](url, 1);
          expect(res.status, `${who} ${method} ${url}`).toBe(403);
        }
        expect((await c.post('/api/dashboard/auth/logout-all')).status).toBe(403);
      }
    });

    it('the permanent Super Admin keeps unrestricted access to them', async () => {
      for (const [method, url] of [['get', '/api/dashboard/whatsapp/qr'], ['get', '/api/dashboard/accounts/1/qr'], ['get', '/api/dashboard/credentials'], ['get', '/api/dashboard/system'], ['get', '/api/dashboard/settings'], ['get', '/api/dashboard/integrations']] as const) {
        expect((await owner[method](url, 1)).status, `${method} ${url}`).toBe(200);
      }
    });

    it('an admin explicitly granted connection access can manage connections but still not configuration', async () => {
      const made = await create({ email: 'conn@example.com', role: 'admin', accountIds: [1], canConnection: true });
      const c = as(made.body.id);
      expect((await c.get('/api/dashboard/accounts/1/qr', 1)).status).toBe(200);
      expect((await c.get('/api/dashboard/credentials', 1)).status).toBe(403);
      expect((await c.get(`/api/dashboard/accounts/${second}/qr`, 1)).status).toBe(403); // not an account this admin can open
    });

    it('server details are not exposed to users who cannot see configuration', async () => {
      const status = await as(ids.alice!).get('/api/dashboard/status', 1);
      expect(status.status).toBe(200);
      expect(status.body.services.length).toBeGreaterThan(0);
      expect(status.body.services.every((s: { detail: string }) => s.detail === '')).toBe(true);
      expect((await owner.get('/api/dashboard/status', 1)).body.services.some((s: { detail: string }) => s.detail !== '')).toBe(true);
    });
  });

  describe('the dashboard overview is account-scoped and permission-aware', () => {
    it('returns real data for the selected account and nulls the sections the user cannot read', async () => {
      const full = await owner.get('/api/dashboard/overview?range=30', 1);
      expect(full.status).toBe(200);
      expect(full.body.account.id).toBe(1);
      expect(full.body.conversations).not.toBeNull();
      expect(full.body.automation.ai.state).toBeTruthy();
      expect(full.body.accounts.items.map((a: { id: number }) => a.id).sort()).toEqual([1, second].sort());

      const dave = await as(ids.dave!).get('/api/dashboard/overview', 1); // custom: no dashboard feature
      expect(dave.status).toBe(403);
    });

    it('a restricted user only ever sees their own accounts in the overview', async () => {
      const bob = await as(ids.bob!).get('/api/dashboard/overview?range=7', second);
      expect(bob.status).toBe(200);
      expect(bob.body.accounts.items.map((a: { id: number }) => a.id)).toEqual([second]);
      expect(bob.body.account.id).toBe(second);
      expect((await as(ids.bob!).get('/api/dashboard/overview', 1)).status).toBe(403);
    });
  });

  describe('listing users', () => {
    it('supports search, role and status filters and pagination, with account names for each user', async () => {
      const all = await owner.get('/api/dashboard/users?limit=100');
      expect(all.status).toBe(200);
      expect(all.body.total).toBeGreaterThanOrEqual(6);
      const ownerRow = all.body.users.find((u: { protected: boolean }) => u.protected);
      expect(ownerRow).toMatchObject({ role: 'super_admin', allAccounts: true, status: 'active' });
      expect((await owner.get('/api/dashboard/users?search=carol')).body.users.map((u: { email: string }) => u.email)).toEqual(['carol@example.com']);
      expect((await owner.get('/api/dashboard/users?role=custom&limit=100')).body.users.every((u: { role: string }) => u.role === 'custom')).toBe(true);
      expect((await owner.get('/api/dashboard/users?limit=2&offset=0')).body.users).toHaveLength(2);
      const carol = (await owner.get('/api/dashboard/users?search=carol')).body.users[0];
      expect(carol.accounts.map((a: { name: string }) => a.name)).toEqual(expect.arrayContaining(['JOTUN Test']));
    });
  });
});
