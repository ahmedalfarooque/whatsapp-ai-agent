import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from '../../../src/memory/db';
import { createAdminUser } from '../../../src/dashboard/auth';
import {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_CHALLENGES_PER_WINDOW,
  OTP_MAX_SENDS,
  OtpError,
  beginOtpLogin,
  cancelOtp,
  configureLoginOtp,
  generateOtpCode,
  maskEmail,
  resendOtp,
  verifyOtp,
  type OtpMessage,
} from '../../../src/dashboard/loginOtp';

const sent: OtpMessage[] = [];
const fakeMailer = vi.fn(async (message: OtpMessage) => {
  sent.push(message);
});
const lastCode = (): string => sent[sent.length - 1]!.code;

async function expectOtpError(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(OtpError);
  await promise.catch((e: OtpError) => {
    expect(e.code).toBe(code);
    if (status) expect(e.status).toBe(status);
  });
}

describe('dashboard login OTP service', () => {
  let adminId: number;
  beforeEach(() => {
    sent.length = 0;
    fakeMailer.mockClear();
    configureLoginOtp({ enabled: true, mailer: fakeMailer });
    getDb().prepare('DELETE FROM admin_login_challenges').run();
    getDb().prepare('DELETE FROM admin_sessions').run();
    getDb().prepare('DELETE FROM admin_users').run();
    adminId = createAdminUser('owner@example.com', 'a-very-long-test-password-123');
  });

  it('generates 6-digit codes from a CSPRNG (never Math.random)', () => {
    const random = vi.spyOn(Math, 'random');
    const codes = new Set(Array.from({ length: 50 }, () => generateOtpCode()));
    expect([...codes].every((c) => /^\d{6}$/.test(c))).toBe(true);
    expect(codes.size).toBeGreaterThan(40);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  it('masks the destination address', () => {
    expect(maskEmail('arshad@example.com')).toBe('a*****@example.com');
    expect(maskEmail('ab@example.com')).toBe('a**@example.com');
    expect(maskEmail('nonsense')).toBe('***');
  });

  it('emails the code and stores only hashes (never the code or the challenge token)', async () => {
    const challenge = await beginOtpLogin(adminId);
    expect(fakeMailer).toHaveBeenCalledTimes(1);
    expect(sent[0]!.to).toBe('owner@example.com');
    expect(sent[0]!.code).toMatch(/^\d{6}$/);
    expect(challenge.challenge.length).toBeGreaterThanOrEqual(32);
    expect(challenge.email).toBe('o****@example.com');
    const row = getDb().prepare('SELECT * FROM admin_login_challenges').get() as Record<string, string>;
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(sent[0]!.code);
    expect(stored).not.toContain(challenge.challenge);
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts the right code exactly once and rejects a replay', async () => {
    const { challenge } = await beginOtpLogin(adminId);
    expect(verifyOtp(challenge, 'nope')).toEqual({ ok: false, code: 'invalid' });
    expect(verifyOtp(challenge, lastCode())).toEqual({ ok: true, adminUserId: adminId });
    expect(verifyOtp(challenge, lastCode())).toEqual({ ok: false, code: 'invalid' });
  });

  it('rejects an expired code', async () => {
    const { challenge } = await beginOtpLogin(adminId);
    getDb().prepare('UPDATE admin_login_challenges SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    expect(verifyOtp(challenge, lastCode())).toEqual({ ok: false, code: 'invalid' });
  });

  it('rejects an unknown challenge token and malformed input without throwing', () => {
    expect(verifyOtp('definitely-not-a-real-challenge-token', '123456')).toEqual({ ok: false, code: 'invalid' });
    expect(verifyOtp(undefined, undefined)).toEqual({ ok: false, code: 'invalid' });
    expect(verifyOtp(42, { code: 1 })).toEqual({ ok: false, code: 'invalid' });
  });

  it('locks the challenge after too many wrong codes, even if the right code follows', async () => {
    const { challenge } = await beginOtpLogin(adminId);
    const right = lastCode();
    const wrong = right === '000000' ? '000001' : '000000';
    for (let i = 1; i < OTP_MAX_ATTEMPTS; i += 1) expect(verifyOtp(challenge, wrong)).toEqual({ ok: false, code: 'invalid' });
    expect(verifyOtp(challenge, wrong)).toEqual({ ok: false, code: 'locked' });
    expect(verifyOtp(challenge, right)).toEqual({ ok: false, code: 'invalid' });
  });

  it('resend: enforces the cooldown, rotates the code and caps the number of emails', async () => {
    const { challenge } = await beginOtpLogin(adminId);
    const first = lastCode();
    await expectOtpError(resendOtp(challenge), 'cooldown', 429);
    const backdate = () => getDb().prepare('UPDATE admin_login_challenges SET last_sent_at = ?').run(new Date(Date.now() - 61_000).toISOString());
    backdate();
    await resendOtp(challenge);
    expect(fakeMailer).toHaveBeenCalledTimes(2);
    const second = lastCode();
    expect(verifyOtp(challenge, first)).toEqual({ ok: false, code: 'invalid' }); // the old code died
    for (let i = fakeMailer.mock.calls.length; i < OTP_MAX_SENDS; i += 1) {
      backdate();
      await resendOtp(challenge);
    }
    backdate();
    await expectOtpError(resendOtp(challenge), 'rate_limited', 429);
    expect(verifyOtp(challenge, second)).toEqual({ ok: false, code: 'invalid' });
    expect(verifyOtp(challenge, lastCode())).toEqual({ ok: true, adminUserId: adminId });
    await expectOtpError(resendOtp(challenge), 'invalid', 410); // nothing to resend once used
  });

  it('caps how many challenges one admin can start per window, even when earlier ones were cancelled', async () => {
    for (let i = 0; i < OTP_MAX_CHALLENGES_PER_WINDOW; i += 1) {
      const { challenge } = await beginOtpLogin(adminId);
      cancelOtp(challenge);
      expect(verifyOtp(challenge, lastCode())).toEqual({ ok: false, code: 'invalid' });
    }
    await expectOtpError(beginOtpLogin(adminId), 'rate_limited', 429);
    expect(fakeMailer).toHaveBeenCalledTimes(OTP_MAX_CHALLENGES_PER_WINDOW);
  });

  it('leaves no usable challenge when the email cannot be sent', async () => {
    configureLoginOtp({ mailer: vi.fn(async () => { throw new Error('provider down'); }) });
    await expectOtpError(beginOtpLogin(adminId), 'send_failed', 503);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM admin_login_challenges').get()).toEqual({ n: 0 });
  });

  it('refuses when no mailer is configured or the admin has no email address', async () => {
    configureLoginOtp({ mailer: null });
    await expectOtpError(beginOtpLogin(adminId), 'not_configured', 503);
    configureLoginOtp({ mailer: fakeMailer });
    const noEmailId = createAdminUser('just-a-name', 'a-very-long-test-password-123');
    await expectOtpError(beginOtpLogin(noEmailId), 'no_email', 503);
    getDb().prepare('UPDATE admin_users SET email = ? WHERE id = ?').run('named@example.com', noEmailId);
    const { email } = await beginOtpLogin(noEmailId); // the explicit email column wins
    expect(email).toBe('n****@example.com');
    expect(sent[sent.length - 1]!.to).toBe('named@example.com');
  });
});
