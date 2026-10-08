import request from 'supertest';
import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import { createApp } from '../../src/app';
import { logger } from '../../src/logger';
import { configureLoginOtp } from '../../src/dashboard/loginOtp';
import { checkAdminCredentials, diagnoseRejectedPassword } from '../../src/dashboard/auth';

const USERNAME = 'diag.admin@example.com';
const PASSWORD = 'Correct-Horse-Battery-Staple-77';

describe('dashboard login diagnostics (booleans only)', () => {
  const app = createApp();
  const logged: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    configureLoginOtp({ enabled: false });
    const setup = await request(app).post('/api/dashboard/auth/setup').send({ username: USERNAME, password: PASSWORD });
    expect(setup.status).toBe(201);
  });

  const capture = () => {
    logged.length = 0;
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      spies.push(vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(JSON.stringify(args)); }) as never));
    }
  };
  afterEach(() => { while (spies.length) spies.pop()!.mockRestore(); });
  const attemptLogs = () => logged.map((l) => JSON.parse(l)[0]).filter((o) => o && o.event === 'dashboard_login_attempt');

  it('checkAdminCredentials tells which half failed', () => {
    expect(checkAdminCredentials(USERNAME, PASSWORD)).toMatchObject({ adminFound: true, adminUserId: expect.any(Number) });
    expect(checkAdminCredentials(USERNAME.toUpperCase(), PASSWORD)).toMatchObject({ adminFound: true, adminUserId: expect.any(Number) });
    expect(checkAdminCredentials(USERNAME, 'wrong')).toEqual({ adminFound: true, adminUserId: null });
    expect(checkAdminCredentials('nobody@example.com', PASSWORD)).toEqual({ adminFound: false, adminUserId: null });
  });

  it('diagnoseRejectedPassword spots whitespace and unicode-normalisation mismatches without returning any value', () => {
    expect(diagnoseRejectedPassword(USERNAME, `${PASSWORD} `)).toMatchObject({ password_has_edge_whitespace: true, trimmed_variant_matches: true });
    expect(diagnoseRejectedPassword(USERNAME, 'nope-nope-nope')).toMatchObject({ password_length: 14, trimmed_variant_matches: false, nfc_variant_matches: false });
  });

  it('a wrong password logs admin_found=true, password_verified=false — and never the credentials', async () => {
    capture();
    const res = await request(app).post('/api/dashboard/auth/login').send({ username: USERNAME, password: 'this-is-not-it-123456' });
    expect(res.status).toBe(401);
    const [entry] = attemptLogs();
    expect(entry).toMatchObject({ username_received: true, password_field_received: true, admin_found: true, password_verified: false, body_keys: ['username', 'password'] });
    expect(typeof entry.password_length).toBe('number');
    const everything = logged.join('\n');
    expect(everything).not.toContain('this-is-not-it-123456');
    expect(everything).not.toContain(USERNAME);
    expect(everything).not.toContain('scrypt$');
  });

  it('an unknown username logs admin_found=false and no password diagnostics', async () => {
    capture();
    await request(app).post('/api/dashboard/auth/login').send({ username: 'ghost@example.com', password: PASSWORD });
    const [entry] = attemptLogs();
    expect(entry).toMatchObject({ admin_found: false, password_verified: false });
    expect(entry.password_length).toBeUndefined();
    expect(logged.join('\n')).not.toContain(PASSWORD);
  });

  it('a successful sign-in logs only booleans: no lengths, no credentials', async () => {
    capture();
    const res = await request(app).post('/api/dashboard/auth/login').send({ username: USERNAME, password: PASSWORD });
    expect(res.status).toBe(200);
    const [entry] = attemptLogs();
    expect(entry).toMatchObject({ admin_found: true, password_verified: true, session_will_be_created: true });
    expect(entry.password_length).toBeUndefined();
    expect(entry.username_length).toBeUndefined();
    const everything = logged.join('\n');
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(USERNAME);
    expect(everything).not.toMatch(/dashboard_session=/);
  });
});
