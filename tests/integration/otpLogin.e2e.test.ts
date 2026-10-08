import request from 'supertest';
import { describe, expect, it, beforeAll, beforeEach, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { logger } from '../../src/logger';
import { configureLoginOtp, OTP_MAX_ATTEMPTS, type OtpMessage } from '../../src/dashboard/loginOtp';

const USERNAME = 'otp-admin@example.com';
const PASSWORD = 'a-very-long-test-password-123';

const sent: OtpMessage[] = [];
const mailer = vi.fn(async (message: OtpMessage) => {
  sent.push(message);
});
const lastCode = (): string => sent[sent.length - 1]!.code;
const cookieOf = (res: request.Response): string | undefined => (res.headers['set-cookie'] as string[] | undefined)?.[0]?.split(';')[0];

describe('dashboard sign-in with emailed one-time code', () => {
  const app = createApp();
  const login = (a = app) => request(a).post('/api/dashboard/auth/login').send({ username: USERNAME, password: PASSWORD });
  const verify = (challenge: unknown, code: unknown, a = app) => request(a).post('/api/dashboard/auth/otp/verify').send({ challenge, code });
  const summary = (cookie?: string, a = app) => (cookie ? request(a).get('/api/dashboard/summary').set('Cookie', cookie) : request(a).get('/api/dashboard/summary'));

  beforeAll(async () => {
    configureLoginOtp({ enabled: true, mailer });
    // First-run setup creates the only admin; it signs that first session in directly (there is no email yet to verify).
    const setup = await request(app).post('/api/dashboard/auth/setup').send({ username: USERNAME, password: PASSWORD });
    expect(setup.status).toBe(201);
    await request(app).post('/api/dashboard/auth/logout').set('Cookie', cookieOf(setup)!);
  });

  beforeEach(() => {
    sent.length = 0;
    mailer.mockClear();
    mailer.mockImplementation(async (message: OtpMessage) => { sent.push(message); });
    configureLoginOtp({ enabled: true, mailer });
    // Each test starts its own challenge; the per-admin cap is covered by the unit tests.
    getDb().prepare('DELETE FROM admin_login_challenges').run();
  });

  it('rejects a wrong password with no email and no challenge', async () => {
    const res = await request(app).post('/api/dashboard/auth/login').send({ username: USERNAME, password: 'wrong-password-wrong' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.challenge).toBeUndefined();
    expect(mailer).not.toHaveBeenCalled();
  });

  it('a correct password only sends the code — no session, no code in the response', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, otpRequired: true, email: 'o******@example.com' });
    expect(typeof res.body.challenge).toBe('string');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(mailer).toHaveBeenCalledTimes(1);
    expect(sent[0]!.to).toBe(USERNAME);
    expect(JSON.stringify(res.body)).not.toContain(lastCode());
    expect((await summary()).status).toBe(401);
  });

  it('wrong code → 401 and still no session; right code → session cookie; replay → 401', async () => {
    const { challenge } = (await login()).body;
    const wrong = await verify(challenge, lastCode() === '000000' ? '000001' : '000000');
    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const ok = await verify(challenge, lastCode());
    expect(ok.status).toBe(200);
    const cookie = cookieOf(ok);
    expect(cookie).toMatch(/^dashboard_session=/);
    expect((await summary(cookie)).status).toBe(200);

    const replay = await verify(challenge, lastCode());
    expect(replay.status).toBe(401);
    expect(replay.headers['set-cookie']).toBeUndefined();

    // logout still ends the session
    await request(app).post('/api/dashboard/auth/logout').set('Cookie', cookie!);
    expect((await summary(cookie)).status).toBe(401);
  });

  it('rejects an expired code', async () => {
    const { challenge } = (await login()).body;
    getDb().prepare('UPDATE admin_login_challenges SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    const res = await verify(challenge, lastCode());
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('locks the challenge after too many wrong codes', async () => {
    const { challenge } = (await login()).body;
    const right = lastCode();
    const wrong = right === '000000' ? '000001' : '000000';
    let last: request.Response | undefined;
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i += 1) last = await verify(challenge, wrong);
    expect(last!.status).toBe(401);
    expect(last!.body.code).toBe('locked');
    const afterLock = await verify(challenge, right);
    expect(afterLock.status).toBe(401);
    expect(afterLock.headers['set-cookie']).toBeUndefined();
  });

  it('resend is rate limited, rotates the code, and a cancelled sign-in cannot be completed', async () => {
    const { challenge } = (await login()).body;
    const first = lastCode();
    const tooSoon = await request(app).post('/api/dashboard/auth/otp/resend').send({ challenge });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.headers['retry-after']).toBeTruthy();
    expect(mailer).toHaveBeenCalledTimes(1);

    getDb().prepare('UPDATE admin_login_challenges SET last_sent_at = ?').run(new Date(Date.now() - 61_000).toISOString());
    const again = await request(app).post('/api/dashboard/auth/otp/resend').send({ challenge });
    expect(again.status).toBe(200);
    expect(JSON.stringify(again.body)).not.toContain(lastCode());
    expect(mailer).toHaveBeenCalledTimes(2);
    expect((await verify(challenge, first)).status).toBe(401);

    const cancel = await request(app).post('/api/dashboard/auth/otp/cancel').send({ challenge });
    expect(cancel.status).toBe(200);
    const afterCancel = await verify(challenge, lastCode());
    expect(afterCancel.status).toBe(401);
    expect(afterCancel.headers['set-cookie']).toBeUndefined();
  });

  it('an email provider failure never authenticates the user', async () => {
    mailer.mockImplementation(async () => { throw new Error('provider down'); });
    const res = await login();
    expect(res.status).toBe(503);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body.challenge).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/provider down|Bearer|re_[A-Za-z0-9]/); // generic message, no internals
    expect((await summary()).status).toBe(401);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM admin_login_challenges').get()).toEqual({ n: 0 });
  });

  it('never writes the code or an API key into the logs', async () => {
    const calls: string[] = [];
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { calls.push(JSON.stringify(args)); }) as never));
    try {
      const { challenge } = (await login()).body;
      getDb().prepare('UPDATE admin_login_challenges SET last_sent_at = ?').run(new Date(Date.now() - 61_000).toISOString());
      await request(app).post('/api/dashboard/auth/otp/resend').send({ challenge });
      await verify(challenge, '000000');
      await verify(challenge, lastCode());
      expect(calls.length).toBeGreaterThan(0);
      for (const message of sent) expect(calls.join('\n')).not.toContain(message.code);
      expect(calls.join('\n')).not.toContain(challenge);
      expect(calls.join('\n')).not.toContain(USERNAME); // only the masked address is logged
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('malformed verify/resend bodies are rejected without leaking anything', async () => {
    expect((await verify(undefined, undefined)).status).toBe(400);
    expect((await verify('x', 123)).status).toBe(400);
    expect((await request(app).post('/api/dashboard/auth/otp/resend').send({})).status).toBe(400);
    expect((await request(app).post('/api/dashboard/auth/otp/cancel').send({})).status).toBe(200);
  });

  it('with the step switched off, a correct password signs in directly (existing behaviour)', async () => {
    configureLoginOtp({ enabled: false });
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.otpRequired).toBeUndefined();
    expect(cookieOf(res)).toMatch(/^dashboard_session=/);
    expect(mailer).not.toHaveBeenCalled();
    expect((await summary(cookieOf(res))).status).toBe(200);
  });
});
