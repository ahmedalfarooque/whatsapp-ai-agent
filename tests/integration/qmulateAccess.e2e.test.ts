import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { provisionBlueprint } from '../../src/accounts/blueprint';
import { QMULATE_BLUEPRINT } from '../../src/accounts/blueprints/qmulate';
import { createSession } from '../../src/dashboard/auth';
import { SESSION_COOKIE_NAME } from '../../src/dashboard/authMiddleware';

/**
 * The new QMULATE account through the real HTTP API: who can see it, and what its connection page says before anyone scans a QR.
 * The Super Admin gets it automatically (every account, including future ones); users assigned to other accounts never do.
 */
const OWNER = 'owner@example.com';
const OWNER_PASSWORD = 'owner-password-very-long-123';
const PASSWORD = 'a-very-long-test-password-123';

describe('QMULATE account: access and connection page', () => {
  const app = createApp();
  let Q: number;
  let other: number;
  const as = (userId: number) => {
    const cookie = `${SESSION_COOKIE_NAME}=${createSession(userId).token}`;
    return {
      get: (url: string, account?: number) => {
        const r = request(app).get(url).set('Cookie', cookie);
        return account ? r.set('X-Whatsapp-Account', String(account)) : r;
      },
    };
  };
  let owner: ReturnType<typeof as>;
  let manager1: ReturnType<typeof as>; // assigned only to the original business
  let managerOther: ReturnType<typeof as>; // assigned only to the other business
  let admin12: ReturnType<typeof as>; // an Admin assigned to accounts 1 and the other one — NOT to QMULATE

  beforeAll(async () => {
    getDb();
    const setup = await request(app).post('/api/dashboard/auth/setup').send({ username: OWNER, password: OWNER_PASSWORD });
    expect(setup.status).toBe(201);
    const ownerId = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get(OWNER) as { id: number }).id;
    owner = as(ownerId);
    other = createAccount({ name: 'JOTUN Access Fixture' }).id;
    Q = provisionBlueprint(QMULATE_BLUEPRINT, { actor: 'test' }).accountId;
    const create = (body: Record<string, unknown>) => request(app).post('/api/dashboard/users').set('Cookie', `${SESSION_COOKIE_NAME}=${createSession(ownerId).token}`).send({ password: PASSWORD, ...body });
    const a = await create({ email: 'one@example.com', role: 'manager', accountIds: [1] });
    const b = await create({ email: 'two@example.com', role: 'manager', accountIds: [other] });
    const c = await create({ email: 'three@example.com', role: 'admin', accountIds: [1, other] });
    for (const r of [a, b, c]) expect(r.status, JSON.stringify(r.body)).toBe(201);
    manager1 = as(a.body.id);
    managerOther = as(b.body.id);
    admin12 = as(c.body.id);
  });

  it('the Super Admin sees the new account in its account list without anyone granting it', async () => {
    const res = await owner.get('/api/dashboard/accounts');
    expect(res.status).toBe(200);
    const ids = (res.body.accounts as { id: number; name: string }[]).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([1, other, Q]));
    expect((res.body.accounts as { id: number; name: string }[]).find((a) => a.id === Q)?.name).toBe('QMULATE Real Estate Consultancy');
  });

  it('users and admins assigned to other accounts do not see it, and cannot open it by header, URL or query string', async () => {
    for (const user of [manager1, managerOther, admin12]) {
      const list = await user.get('/api/dashboard/accounts');
      expect((list.body.accounts as { id: number }[]).map((a) => a.id)).not.toContain(Q);
      expect((await user.get('/api/dashboard/customers', Q)).status).toBe(403);
      expect((await user.get('/api/dashboard/templates', Q)).status).toBe(403);
      expect((await user.get('/api/dashboard/business-profile', Q)).status).toBe(403);
      expect((await user.get(`/api/dashboard/accounts/${Q}/qr`)).status).toBe(403);
      expect((await user.get(`/api/dashboard/customers?account=${Q}`)).status).toBe(403);
    }
  });

  it('the profile, templates and customers an account page reads are QMULATE\'s own when QMULATE is selected — and only then', async () => {
    const profile = await owner.get('/api/dashboard/business-profile', Q);
    expect(profile.status).toBe(200);
    expect(profile.body.settings.businessName).toBe('QMULATE Real Estate Consultancy');
    expect(profile.body.activeNumber).toBeNull();
    const original = await owner.get('/api/dashboard/business-profile', 1);
    expect(JSON.stringify(original.body)).not.toMatch(/qmulate/i);
    const otherProfile = await owner.get('/api/dashboard/business-profile', other);
    expect(JSON.stringify(otherProfile.body)).not.toMatch(/qmulate/i);
    const customers = await owner.get('/api/dashboard/customers', Q);
    expect(customers.status).toBe(200);
    expect(JSON.stringify(customers.body)).not.toMatch(/9665/);
  });

  it('its connection page is ready for a QR scan but NOT connected: no number, no profile name, never "connected" because a QR exists', async () => {
    for (const url of [`/api/dashboard/accounts/${Q}/qr`]) {
      const res = await owner.get(url);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ accountId: Q, accountName: 'QMULATE Real Estate Consultancy', enabled: true, phoneNumber: null, displayName: null, connectedAt: null, hasSavedSession: false });
      expect(res.body.phase).not.toBe('connected');
    }
    const viaHeader = await owner.get('/api/dashboard/whatsapp/qr', Q);
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body.accountId).toBe(Q);
    expect(viaHeader.body.phase).not.toBe('connected');
  });

  it('opening the QMULATE connection page does not disturb the other accounts\' connection state', async () => {
    for (const id of [1, other]) {
      const res = await owner.get('/api/dashboard/whatsapp/qr', id);
      expect(res.status).toBe(200);
      expect(res.body.accountId).toBe(id);
      expect(res.body.accountName).not.toMatch(/qmulate/i);
    }
  });
});
