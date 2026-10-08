import request from 'supertest';
import { describe, expect, it, beforeAll } from 'vitest';
import { createApp } from '../../src/app';
import { configureLoginOtp } from '../../src/dashboard/loginOtp';

const USERNAME = 'Owner.Login@Example.com';
const PASSWORD = 'a-very-long-test-password-123';

describe('dashboard login behind a reverse proxy', () => {
  const app = createApp();
  const login = (username: string, password: string, forwardedFor?: string) => {
    const req = request(app).post('/api/dashboard/auth/login');
    if (forwardedFor) req.set('X-Forwarded-For', forwardedFor);
    return req.send({ username, password });
  };

  beforeAll(async () => {
    configureLoginOtp({ enabled: false });
    const setup = await request(app).post('/api/dashboard/auth/setup').send({ username: USERNAME, password: PASSWORD });
    expect(setup.status).toBe(201);
  });

  it('matches the username regardless of letter case or surrounding spaces (phone keyboards capitalise)', async () => {
    for (const typed of ['owner.login@example.com', 'OWNER.LOGIN@EXAMPLE.COM', '  Owner.Login@Example.com  ']) {
      const res = await login(typed, PASSWORD, '203.0.113.50');
      expect(res.status, typed).toBe(200);
      expect(res.headers['set-cookie']?.[0]).toMatch(/^dashboard_session=/);
    }
  });

  it('still rejects a wrong password for the same account', async () => {
    const res = await login('owner.login@example.com', 'definitely-not-the-password', '203.0.113.51');
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rate-limits each real client separately, so one visitor cannot lock out another', async () => {
    const attacker = '198.51.100.7';
    let last = 0;
    for (let i = 0; i < 11; i += 1) last = (await login('nobody@example.com', 'wrong-password-0000', attacker)).status;
    expect(last).toBe(429);

    // A different client address (as forwarded by the proxy) still gets a normal answer.
    const owner = await login('owner.login@example.com', PASSWORD, '203.0.113.99');
    expect(owner.status).toBe(200);
  });

  it('answers a lockout with a JSON message the dashboard can show', async () => {
    const client = '198.51.100.8';
    let res = await login('nobody@example.com', 'wrong-password-0000', client);
    for (let i = 0; i < 10; i += 1) res = await login('nobody@example.com', 'wrong-password-0000', client);
    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toMatchObject({ code: 'rate_limited' });
    expect(res.body.error).toMatch(/too many/i);
    expect(res.headers['retry-after']).toBeTruthy();
  });

  it('does not let a client behind the proxy spoof its way past the limit by rotating the leftmost forwarded value', async () => {
    // The proxy appends the real address; a client-supplied prefix must not create fresh buckets.
    const real = '198.51.100.9';
    let last = 0;
    for (let i = 0; i < 12; i += 1) last = (await login('nobody@example.com', 'wrong-password-0000', `10.0.0.${i}, ${real}`)).status;
    expect(last).toBe(429);
  });
});
