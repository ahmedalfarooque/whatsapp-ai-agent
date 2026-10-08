import crypto from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../logger';
import { getDb } from '../memory/db';
import { resendConfigured, sendResendEmail } from '../email/resendMailer';

/**
 * Email one-time-code second step for dashboard sign-in.
 *
 * Flow: password verified (auth.ts) → beginOtpLogin() issues a challenge and
 * emails a 6-digit code → the browser posts challenge + code → verifyOtp()
 * → only then does the router create the session cookie.
 *
 * What is stored: SHA-256(challenge token) for lookup and
 * HMAC-SHA256(key = challenge token, message = code). The token lives only
 * in the browser's memory for the duration of the sign-in, so a copy of the
 * database alone cannot be used to compute or brute-force a code offline.
 * The code is never logged, never returned by any API and never persisted.
 */

export const OTP_CODE_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
/** Initial email + resends allowed per challenge. */
export const OTP_MAX_SENDS = 3;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
/** Challenges one admin may start per window (password-verified requests only). */
export const OTP_MAX_CHALLENGES_PER_WINDOW = 5;
const OTP_CHALLENGE_WINDOW_MS = 15 * 60 * 1000;

export interface OtpMessage {
  to: string;
  code: string;
  expiresMinutes: number;
}
export type OtpMailer = (message: OtpMessage) => Promise<void>;

export type OtpErrorCode = 'not_configured' | 'no_email' | 'send_failed' | 'rate_limited' | 'cooldown' | 'invalid' | 'locked';

export class OtpError extends Error {
  constructor(
    public readonly code: OtpErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'OtpError';
  }
}

const resendOtpMailer: OtpMailer = async ({ to, code, expiresMinutes }) => {
  const app = env.OPENROUTER_APP_NAME || 'WhatsApp AI Agent';
  await sendResendEmail({
    to,
    subject: `${code} is your ${app} sign-in code`,
    text: `Your ${app} dashboard sign-in code is: ${code}\n\nIt expires in ${expiresMinutes} minutes and can be used once.\nIf you did not try to sign in, you can ignore this email — your password alone does not open the dashboard.`,
    html: `<p style="font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1b2430">Your <b>${app}</b> dashboard sign-in code is:</p><p style="font:600 32px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3em;color:#0f172a;margin:16px 0">${code}</p><p style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#475467">It expires in ${expiresMinutes} minutes and can be used once.<br>If you did not try to sign in, ignore this email — your password alone does not open the dashboard.</p>`,
  });
};

interface OtpConfig {
  enabled: boolean;
  mailer: OtpMailer | null;
}
const config: OtpConfig = {
  enabled: env.loginOtpEnabled,
  mailer: resendConfigured() ? resendOtpMailer : null,
};

/** Runtime override — used by tests (deterministic fake mailer) and local development. */
export function configureLoginOtp(overrides: Partial<OtpConfig>): void {
  Object.assign(config, overrides);
}
export function loginOtpEnabled(): boolean {
  return config.enabled;
}
export function loginOtpDeliverable(): boolean {
  return config.mailer !== null;
}

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');
const codeHash = (token: string, code: string): Buffer => crypto.createHmac('sha256', token).update(code).digest();

/** Cryptographically secure 6-digit code (never Math.random). */
export function generateOtpCode(): string {
  return crypto.randomInt(0, 10 ** OTP_CODE_LENGTH).toString().padStart(OTP_CODE_LENGTH, '0');
}

/** `arshad@example.com` → `a*****@example.com` — enough for the person to recognise the inbox, nothing more. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return `${local[0]}${'*'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${email.slice(at + 1)}`;
}

interface AdminEmailRow {
  username: string;
  email: string | null;
}

/** The address that receives the code: the explicit email column, else the username when it is an address. */
export function adminOtpEmail(adminUserId: number): string | null {
  const row = getDb().prepare('SELECT username, email FROM admin_users WHERE id = ?').get(adminUserId) as AdminEmailRow | undefined;
  if (!row) return null;
  const candidate = (row.email ?? '').trim() || row.username.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

interface ChallengeRow {
  id: string;
  admin_user_id: number;
  code_hash: string;
  attempts: number;
  sends: number;
  last_sent_at: string;
  expires_at: string;
  consumed_at: string | null;
}

function loadChallenge(token: unknown): ChallengeRow | undefined {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return undefined;
  return getDb()
    .prepare('SELECT id, admin_user_id, code_hash, attempts, sends, last_sent_at, expires_at, consumed_at FROM admin_login_challenges WHERE token_hash = ?')
    .get(sha256(token)) as ChallengeRow | undefined;
}

/**
 * Rows stay for the whole rate-limit window even once used, locked, expired or
 * cancelled — the per-admin cap counts every challenge started in the window,
 * so cancelling and re-requesting cannot be used to send unlimited emails.
 */
function purgeStale(): void {
  getDb().prepare('DELETE FROM admin_login_challenges WHERE created_at < ?').run(new Date(Date.now() - OTP_CHALLENGE_WINDOW_MS).toISOString());
}

function closeChallenge(id: string, attempts?: number): void {
  const nowIso = new Date().toISOString();
  if (attempts === undefined) getDb().prepare('UPDATE admin_login_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(nowIso, id);
  else getDb().prepare('UPDATE admin_login_challenges SET consumed_at = ?, attempts = ? WHERE id = ? AND consumed_at IS NULL').run(nowIso, attempts, id);
}

export interface OtpChallenge {
  challenge: string;
  expiresAt: string;
  /** Masked destination, e.g. a*****@example.com */
  email: string;
}

/**
 * Starts the second step for an admin whose password was just verified.
 * Issues the challenge, emails the code, and returns what the browser needs.
 * Nothing is left behind when the email cannot be sent.
 */
export async function beginOtpLogin(adminUserId: number): Promise<OtpChallenge> {
  if (!config.mailer) throw new OtpError('not_configured', 'Verification codes cannot be sent right now (email delivery is not configured).', 503);
  const to = adminOtpEmail(adminUserId);
  if (!to) throw new OtpError('no_email', 'This administrator account has no email address to receive verification codes.', 503);

  const db = getDb();
  purgeStale();
  const windowStart = new Date(Date.now() - OTP_CHALLENGE_WINDOW_MS).toISOString();
  const recent = (db.prepare('SELECT COUNT(*) AS n FROM admin_login_challenges WHERE admin_user_id = ? AND created_at >= ?').get(adminUserId, windowStart) as { n: number }).n;
  if (recent >= OTP_MAX_CHALLENGES_PER_WINDOW) {
    throw new OtpError('rate_limited', 'Too many sign-in attempts. Wait a few minutes and try again.', 429, Math.ceil(OTP_CHALLENGE_WINDOW_MS / 1000));
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const code = generateOtpCode();
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO admin_login_challenges (id, admin_user_id, token_hash, code_hash, attempts, sends, last_sent_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`,
  ).run(id, adminUserId, sha256(token), codeHash(token, code).toString('hex'), now.toISOString(), expiresAt, now.toISOString());

  try {
    await config.mailer({ to, code, expiresMinutes: Math.round(OTP_TTL_MS / 60000) });
  } catch (error) {
    db.prepare('DELETE FROM admin_login_challenges WHERE id = ?').run(id);
    logger.warn({ adminUserId, challengeId: id, error: (error as Error).message }, 'login otp: verification email could not be sent');
    throw new OtpError('send_failed', 'The verification email could not be sent. Please try again in a moment.', 503);
  }
  logger.info({ adminUserId, challengeId: id, to: maskEmail(to) }, 'login otp: code sent');
  return { challenge: token, expiresAt, email: maskEmail(to) };
}

export type OtpVerification = { ok: true; adminUserId: number } | { ok: false; code: 'invalid' | 'locked' };

/** Checks a code once. A correct code consumes the challenge; a wrong one counts an attempt; too many attempts destroy it. */
export function verifyOtp(token: unknown, code: unknown): OtpVerification {
  const digits = typeof code === 'string' ? code.replace(/\D/g, '') : '';
  const row = loadChallenge(token);
  if (!row) return { ok: false, code: 'invalid' };
  const db = getDb();
  const nowIso = new Date().toISOString();
  // Used, cancelled, locked or expired challenges all answer "invalid" — nothing distinguishes them to a caller.
  if (row.consumed_at || row.expires_at <= nowIso) return { ok: false, code: 'invalid' };
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    closeChallenge(row.id);
    return { ok: false, code: 'locked' };
  }
  const expected = Buffer.from(row.code_hash, 'hex');
  const actual = digits.length === OTP_CODE_LENGTH ? codeHash(token as string, digits) : Buffer.alloc(expected.length);
  const matches = digits.length === OTP_CODE_LENGTH && expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (matches) {
    // Single use: this UPDATE succeeds for exactly one verifier, even under concurrent requests.
    const consumed = db
      .prepare('UPDATE admin_login_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND expires_at > ?')
      .run(nowIso, row.id, nowIso).changes;
    if (consumed !== 1) return { ok: false, code: 'invalid' };
    logger.info({ adminUserId: row.admin_user_id, challengeId: row.id }, 'login otp: verified');
    return { ok: true, adminUserId: row.admin_user_id };
  }
  const attempts = row.attempts + 1;
  if (attempts >= OTP_MAX_ATTEMPTS) {
    closeChallenge(row.id, attempts);
    logger.warn({ adminUserId: row.admin_user_id, challengeId: row.id }, 'login otp: too many wrong codes - challenge locked');
    return { ok: false, code: 'locked' };
  }
  db.prepare('UPDATE admin_login_challenges SET attempts = ? WHERE id = ?').run(attempts, row.id);
  return { ok: false, code: 'invalid' };
}

/** Emails a fresh code for an open challenge (cooldown + per-challenge send cap). The previous code stops working. */
export async function resendOtp(token: unknown): Promise<{ expiresAt: string; email: string }> {
  if (!config.mailer) throw new OtpError('not_configured', 'Verification codes cannot be sent right now (email delivery is not configured).', 503);
  const row = loadChallenge(token);
  const now = Date.now();
  if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= now) {
    throw new OtpError('invalid', 'This sign-in attempt has expired. Please sign in again.', 410);
  }
  if (row.sends >= OTP_MAX_SENDS) throw new OtpError('rate_limited', 'No more codes can be sent for this sign-in. Please start again.', 429);
  const waitMs = new Date(row.last_sent_at).getTime() + OTP_RESEND_COOLDOWN_MS - now;
  if (waitMs > 0) throw new OtpError('cooldown', `Please wait ${Math.ceil(waitMs / 1000)}s before requesting another code.`, 429, Math.ceil(waitMs / 1000));
  const to = adminOtpEmail(row.admin_user_id);
  if (!to) throw new OtpError('no_email', 'This administrator account has no email address to receive verification codes.', 503);

  const code = generateOtpCode();
  try {
    await config.mailer({ to, code, expiresMinutes: Math.round(OTP_TTL_MS / 60000) });
  } catch (error) {
    logger.warn({ adminUserId: row.admin_user_id, challengeId: row.id, error: (error as Error).message }, 'login otp: resend failed');
    throw new OtpError('send_failed', 'The verification email could not be sent. Please try again in a moment.', 503);
  }
  const expiresAt = new Date(now + OTP_TTL_MS).toISOString();
  getDb()
    .prepare('UPDATE admin_login_challenges SET code_hash = ?, sends = sends + 1, last_sent_at = ?, expires_at = ? WHERE id = ? AND consumed_at IS NULL')
    .run(codeHash(token as string, code).toString('hex'), new Date(now).toISOString(), expiresAt, row.id);
  logger.info({ adminUserId: row.admin_user_id, challengeId: row.id, sends: row.sends + 1 }, 'login otp: code re-sent');
  return { expiresAt, email: maskEmail(to) };
}

/** Abandons a sign-in attempt ("Back" in the UI). Idempotent; never reveals whether the token was valid. */
export function cancelOtp(token: unknown): void {
  const row = loadChallenge(token);
  if (row && !row.consumed_at) closeChallenge(row.id);
}
