import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { createAdminUser, createSession } from '../../src/dashboard/auth';

describe('QR connection access controls', () => {
  const app = createApp();
  it('rejects unauthenticated status, connect, and disconnect', async () => {
    expect((await request(app).get('/api/dashboard/whatsapp/qr')).status).toBe(401);
    expect((await request(app).post('/api/dashboard/whatsapp/qr/connect')).status).toBe(401);
    expect((await request(app).post('/api/dashboard/whatsapp/qr/disconnect')).status).toBe(401);
  });
  it('does not report an invalid session cookie as signed in', async () => {
    const response = await request(app).get('/api/dashboard/auth/status').set('Cookie', 'dashboard_session=invalid');
    expect(response.body.authenticated).toBe(false);
  });
  it('disables real linking in test mode and prevents QR caching', async () => {
    const id = createAdminUser('qr-security-admin', 'a-secure-test-password');
    const session = createSession(id);
    const cookie = `dashboard_session=${session.token}`;
    const status = await request(app).get('/api/dashboard/whatsapp/qr').set('Cookie', cookie);
    expect(status.status).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.body.available).toBe(false);
    expect(status.body.qr).toBeNull();
    expect((await request(app).post('/api/dashboard/whatsapp/qr/connect').set('Cookie', cookie)).status).toBe(409);
  });
});
