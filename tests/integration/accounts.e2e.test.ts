import request from 'supertest';
import { describe, expect, it, beforeAll } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { getOrCreateCustomer } from '../../src/memory/customerRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { createOffer } from '../../src/offers/offerRepo';
import { grantAccountAccess, revokeAccountAccess } from '../../src/accounts/accountRepo';
import { hashPassword } from '../../src/dashboard/auth';

/**
 * One login, one application, several WhatsApp accounts: the dashboard names
 * the business it works on in the X-Whatsapp-Account header and the server
 * scopes (and authorizes) everything from it.
 */
describe('dashboard — WhatsApp accounts', () => {
  const app = createApp();
  const agent = request.agent(app);
  let salonId: number;
  let carsOfferId: number;

  beforeAll(async () => {
    const setup = await agent.post('/api/dashboard/auth/setup').send({ username: 'multi-admin', password: 'a-very-long-test-password-123' });
    expect(setup.status).toBe(201);
    getOrCreateCustomer('15550009999', 'Cars customer');
    carsOfferId = createOffer({ titleAr: 'عرض', titleEn: 'Cars offer' }, 'test').id;
  });

  it('lists the legacy account by default and reports which account the request ran on', async () => {
    const res = await agent.get('/api/dashboard/accounts');
    expect(res.status).toBe(200);
    expect(res.body.selected).toBe(1);
    expect(res.headers['x-whatsapp-account']).toBe('1');
    expect(res.body.accounts.map((a: { id: number }) => a.id)).toEqual([1]);
    expect(res.body.accounts[0]).toMatchObject({ isLegacy: true, enabled: true, connectionMethod: 'qr' });
    expect(['qr_required', 'disconnected', 'connecting', 'connected', 'error']).toContain(res.body.accounts[0].uiStatus);
  });

  it('creates a second business (Arabic name supported) and switches context through the header', async () => {
    const created = await agent.post('/api/dashboard/accounts').send({ name: 'Noor Salon', nameAr: 'صالون نور', businessCategory: 'Beauty salon' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Noor Salon', nameAr: 'صالون نور', businessCategory: 'Beauty salon', enabled: true, isLegacy: false, phoneNumber: null });
    salonId = created.body.id;
    expect(salonId).toBe(2);

    const invalid = await agent.post('/api/dashboard/accounts').send({ name: '' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.fields.name).toBeTruthy();

    const carsCustomers = await agent.get('/api/dashboard/customers');
    expect(carsCustomers.body.total).toBeGreaterThanOrEqual(1);
    const salonCustomers = await agent.get('/api/dashboard/customers').set('X-Whatsapp-Account', String(salonId));
    expect(salonCustomers.status).toBe(200);
    expect(salonCustomers.headers['x-whatsapp-account']).toBe(String(salonId));
    expect(salonCustomers.body.total).toBe(0);

    const salonProfile = await agent.get('/api/dashboard/business-profile').set('X-Whatsapp-Account', String(salonId));
    expect(salonProfile.body.accountId).toBe(salonId);
    expect(salonProfile.body.settings.businessName).toBe('Noor Salon');
    const carsProfile = await agent.get('/api/dashboard/business-profile');
    expect(carsProfile.body.settings.businessName).not.toBe('Noor Salon');

    // Editing the salon profile never touches the car business.
    const saved = await agent.put('/api/dashboard/business-profile').set('X-Whatsapp-Account', String(salonId)).send({ descriptionEn: 'Nails and hair' });
    expect(saved.status).toBe(200);
    expect((await agent.get('/api/dashboard/business-profile')).body.settings.descriptionEn).not.toBe('Nails and hair');
    const accounts = await agent.get('/api/dashboard/accounts');
    expect(accounts.body.accounts.map((a: { id: number }) => a.id)).toEqual([1, salonId]);
  });

  it('every page endpoint answers for the second account too, with that account\'s (empty) data', async () => {
    for (const url of ['/api/dashboard/summary', '/api/dashboard/offers', '/api/dashboard/templates', '/api/dashboard/requests', '/api/dashboard/automation', '/api/dashboard/documents', '/api/dashboard/whatsapp/qr', '/api/dashboard/status', '/api/dashboard/knowledge', '/api/dashboard/services', '/api/dashboard/support-queue', '/api/dashboard/conversations', '/api/dashboard/bookings', '/api/dashboard/notifications']) {
      const res = await agent.get(url).set('X-Whatsapp-Account', String(salonId));
      expect(res.status, url).toBe(200);
    }
    const offers = await agent.get('/api/dashboard/offers').set('X-Whatsapp-Account', String(salonId));
    expect(offers.body.offers).toEqual([]);
    const summary = await agent.get('/api/dashboard/summary').set('X-Whatsapp-Account', String(salonId));
    expect(summary.body.customers).toBe(0);
    const qr = await agent.get('/api/dashboard/whatsapp/qr').set('X-Whatsapp-Account', String(salonId));
    expect(qr.body.accountId).toBe(salonId);
    expect(qr.body.accountName).toBe('Noor Salon');
    // Knowledge for the salon is its own (empty) directory, not the car business's files.
    const knowledge = await agent.get('/api/dashboard/knowledge').set('X-Whatsapp-Account', String(salonId));
    expect(knowledge.body.files.every((f: { exists: boolean }) => f.exists === false)).toBe(true);
  });

  it('ids from another business are "not found"; unknown accounts are 404', async () => {
    const crossOffer = await agent.get(`/api/dashboard/offers/${carsOfferId}`).set('X-Whatsapp-Account', String(salonId));
    expect(crossOffer.status).toBe(404);
    const ownOffer = await agent.get(`/api/dashboard/offers/${carsOfferId}`);
    expect(ownOffer.status).toBe(200);
    const salonOffer = runWithAccount(salonId, () => createOffer({ titleAr: 'ق', titleEn: 'Salon offer' }, 'test'));
    expect((await agent.post(`/api/dashboard/offers/${salonOffer.id}/publish`)).status).toBe(404);
    expect((await agent.post(`/api/dashboard/offers/${salonOffer.id}/publish`).set('X-Whatsapp-Account', String(salonId))).status).toBe(200);
    expect((await agent.get('/api/dashboard/customers').set('X-Whatsapp-Account', '999')).status).toBe(404);
    expect((await agent.get('/api/dashboard/customers').set('X-Whatsapp-Account', 'abc')).status).toBe(404);
    expect((await agent.get('/api/dashboard/accounts/999')).status).toBe(404);
  });

  it('per-account QR endpoints and enable/disable', async () => {
    const status = await agent.get(`/api/dashboard/accounts/${salonId}/qr`);
    expect(status.status).toBe(200);
    expect(status.body.accountId).toBe(salonId);
    expect(status.body.available).toBe(false); // test mode never opens a real socket
    const unknownAction = await agent.post(`/api/dashboard/accounts/${salonId}/qr/explode`);
    expect(unknownAction.status).toBe(404);

    const disabled = await agent.post(`/api/dashboard/accounts/${salonId}/disable`);
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ enabled: false, uiStatus: 'disabled' });
    const enabled = await agent.post(`/api/dashboard/accounts/${salonId}/enable`);
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);

    const renamed = await agent.put(`/api/dashboard/accounts/${salonId}`).send({ name: 'Noor Beauty' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Noor Beauty');
    expect((await agent.get('/api/dashboard/business-profile').set('X-Whatsapp-Account', String(salonId))).body.settings.businessName).toBe('Noor Beauty');
  });

  it('authorization: an admin restricted to one account cannot read another and lands on their own by default', async () => {
    // A second dashboard user (a plain admin) restricted to the salon. The permanent Super Admin ('multi-admin') is never restricted.
    const restrictedId = Number(getDb().prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('restricted-admin', hashPassword('a-very-long-test-password-123')).lastInsertRowid);
    const restricted = request.agent(app);
    expect((await restricted.post('/api/dashboard/auth/login').send({ username: 'restricted-admin', password: 'a-very-long-test-password-123' })).status).toBe(200);
    grantAccountAccess(restrictedId, salonId, 'manager');
    try {
      const forbidden = await restricted.get('/api/dashboard/customers').set('X-Whatsapp-Account', '1');
      expect(forbidden.status).toBe(403);
      expect((await restricted.get('/api/dashboard/accounts/1')).status).toBe(403);
      const defaulted = await restricted.get('/api/dashboard/accounts');
      expect(defaulted.status).toBe(200);
      expect(defaulted.body.selected).toBe(salonId);
      expect(defaulted.body.accounts.map((a: { id: number }) => a.id)).toEqual([salonId]);
    } finally {
      revokeAccountAccess(restrictedId, salonId);
    }
    expect((await restricted.get('/api/dashboard/customers').set('X-Whatsapp-Account', '1')).status).toBe(200);
    // The permanent Super Admin keeps every account even if access rows are (wrongly) written for it.
    const superId = (getDb().prepare('SELECT id FROM admin_users WHERE username = ?').get('multi-admin') as { id: number }).id;
    grantAccountAccess(superId, salonId, 'manager');
    try {
      expect((await agent.get('/api/dashboard/customers').set('X-Whatsapp-Account', '1')).status).toBe(200);
      expect((await agent.get('/api/dashboard/accounts')).body.accounts.map((a: { id: number }) => a.id)).toContain(1);
    } finally {
      revokeAccountAccess(superId, salonId);
    }
  });
});
