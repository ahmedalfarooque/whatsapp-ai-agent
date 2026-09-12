import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getOrCreateCustomer } from '../../src/memory/customerRepo';
import { getOrCreateActiveConversation, appendMessage, resetConversation } from '../../src/memory/conversationRepo';
import { acquireLock, confirmLock, buildIdempotencyKey, buildSlotKey } from '../../src/memory/bookingLockRepo';
import { getDb } from '../../src/memory/db';

const KNOWLEDGE_DIR = path.join(__dirname, '..', '..', 'knowledge');
const BACKUP_DIR = path.join(KNOWLEDGE_DIR, '.backups');

describe('dashboard', () => {
  const app = createApp();
  const agent = request.agent(app);
  let customerAId: number;
  let conversationAId: number;
  let originalFaqContent: string;

  beforeAll(async () => {
    // Every dashboard API route (other than auth itself) now requires a
    // real authenticated session — set one up once for this whole suite.
    const setup = await agent
      .post('/api/dashboard/auth/setup')
      .send({ username: 'test-admin', password: 'a-very-long-test-password-123' });
    expect(setup.status).toBe(201);

    const db = getDb();
    const customerA = getOrCreateCustomer('15550001111', 'Alice Example', db);
    customerAId = customerA.id;
    const conversationA = getOrCreateActiveConversation(customerAId, db);
    conversationAId = conversationA.id;
    appendMessage(conversationAId, { role: 'user', content: 'Hi, what are your hours?' }, db);
    appendMessage(conversationAId, { role: 'assistant', content: 'We are open Mon-Sat, 9am-6pm.' }, db);

    const customerB = getOrCreateCustomer('15550002222', undefined, db);
    getOrCreateActiveConversation(customerB.id, db);

    const slotKey = buildSlotKey('primary', '2099-01-01T10:00:00.000Z', '2099-01-01T10:30:00.000Z');
    const idempotencyKey = buildIdempotencyKey(conversationAId, '2099-01-01T10:00:00.000Z', '2099-01-01T10:30:00.000Z', 'Consult');
    const lockResult = acquireLock(
      { slotKey, idempotencyKey, conversationId: conversationAId, startISO: '2099-01-01T10:00:00.000Z', endISO: '2099-01-01T10:30:00.000Z' },
      db,
    );
    if (lockResult.acquired) confirmLock(lockResult.lock.id, 'evt_test_1', db);

    originalFaqContent = fs.existsSync(path.join(KNOWLEDGE_DIR, 'faq.md'))
      ? fs.readFileSync(path.join(KNOWLEDGE_DIR, 'faq.md'), 'utf-8')
      : '';
  });

  afterAll(() => {
    if (originalFaqContent) fs.writeFileSync(path.join(KNOWLEDGE_DIR, 'faq.md'), originalFaqContent, 'utf-8');
    if (fs.existsSync(BACKUP_DIR)) fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  });

  // ---- Auth gating ---------------------------------------------------------
  it('rejects an unauthenticated request to a dashboard data route', async () => {
    const res = await request(app).get('/api/dashboard/summary');
    expect(res.status).toBe(401);
  });

  // ---- Root / shell ------------------------------------------------------
  it('redirects the root route to the dashboard', async () => {
    const response = await agent.get('/');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/dashboard');
  });

  it('serves the dashboard shell with working navigation links, and no dead "#" hrefs', async () => {
    const page = await agent.get('/dashboard');
    expect(page.status).toBe(200);
    expect(page.text).toContain('WhatsApp AI Agent');
    expect(page.text).toContain('id="view"');
    // every nav item must be a real hash route, not a bare "#" placeholder
    const hrefMatches = [...page.text.matchAll(/href="(#[^"]*)"/g)].map((m) => m[1]);
    expect(hrefMatches.length).toBeGreaterThan(5);
    expect(hrefMatches.every((href) => href.length > 1)).toBe(true);
  });

  it('serves the dashboard static assets referenced by the shell', async () => {
    const script = await agent.get('/dashboard/app.js');
    expect(script.status).toBe(200);
    const style = await agent.get('/dashboard/styles.css');
    expect(style.status).toBe(200);
  });

  it('does not change health and readiness routes', async () => {
    expect((await agent.get('/health')).status).toBe(200);
    expect((await agent.get('/readiness')).status).toBe(200);
  });

  // ---- Summary / status ---------------------------------------------------
  it('summary reflects real database counts, not a fixed placeholder', async () => {
    const summary = await agent.get('/api/dashboard/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.customers).toBeGreaterThanOrEqual(2);
    expect(summary.body.conversations).toBeGreaterThanOrEqual(2);
    expect(summary.body.bookings).toBeGreaterThanOrEqual(1); // fixed: reads booking_locks, not the unused booking_sessions table
  });

  it('status reports provider mode and knowledge file presence', async () => {
    const status = await agent.get('/api/dashboard/status');
    expect(status.status).toBe(200);
    expect(status.body.providerMode).toBe('mock');
    expect(Array.isArray(status.body.services)).toBe(true);
    expect(Array.isArray(status.body.knowledge)).toBe(true);
  });

  // ---- Customers --------------------------------------------------------
  it('lists customers with real conversation/booking counts', async () => {
    const res = await agent.get('/api/dashboard/customers');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    const alice = res.body.items.find((c: { id: number }) => c.id === customerAId);
    expect(alice.conversationCount).toBeGreaterThanOrEqual(1);
    expect(alice.bookingCount).toBeGreaterThanOrEqual(1);
  });

  it('search filters customers by name/number', async () => {
    const res = await agent.get('/api/dashboard/customers?search=Alice');
    expect(res.status).toBe(200);
    expect(res.body.items.every((c: { display_name: string }) => c.display_name?.includes('Alice'))).toBe(true);

    const none = await agent.get('/api/dashboard/customers?search=NoSuchCustomerXYZ');
    expect(none.body.items).toEqual([]);
  });

  it('paginates customers and never exceeds the max page size', async () => {
    const res = await agent.get('/api/dashboard/customers?limit=999&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(100);
  });

  it('returns a real customer detail record', async () => {
    const res = await agent.get(`/api/dashboard/customers/${customerAId}`);
    expect(res.status).toBe(200);
    expect(res.body.wa_id).toBe('15550001111');
    expect(res.body.conversationCount).toBeGreaterThanOrEqual(1);
  });

  it('returns 404 for a customer id that does not exist', async () => {
    const res = await agent.get('/api/dashboard/customers/999999');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-numeric customer id (not a raw SQL/stack trace leak)', async () => {
    const res = await agent.get('/api/dashboard/customers/not-a-number');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at\s+\w+\s+\(/);
  });

  // ---- Conversations ------------------------------------------------------
  it('lists conversations with message counts', async () => {
    const res = await agent.get('/api/dashboard/conversations');
    expect(res.status).toBe(200);
    const convo = res.body.items.find((c: { id: number }) => c.id === conversationAId);
    expect(convo.messageCount).toBeGreaterThanOrEqual(2);
  });

  it('filters conversations by status', async () => {
    const activeOnly = await agent.get('/api/dashboard/conversations?status=active');
    expect(activeOnly.body.items.every((c: { status: string }) => c.status === 'active')).toBe(true);
  });

  it('returns real chronological messages for a conversation detail, never fabricated', async () => {
    const res = await agent.get(`/api/dashboard/conversations/${conversationAId}`);
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2);
    expect(res.body.messages[0].role).toBe('user');
    expect(res.body.messages[0].content).toContain('what are your hours');
  });

  it('returns 404 for a conversation that does not exist', async () => {
    const res = await agent.get('/api/dashboard/conversations/999999');
    expect(res.status).toBe(404);
  });

  it('shows an ended conversation correctly after a restart, without losing history', async () => {
    resetConversation(customerAId);
    const res = await agent.get(`/api/dashboard/conversations/${conversationAId}`);
    expect(res.body.conversation.status).toBe('ended');
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2); // history preserved, not deleted
  });

  // ---- Bookings -----------------------------------------------------------
  it('lists real confirmed bookings from booking_locks', async () => {
    const res = await agent.get('/api/dashboard/bookings?status=confirmed');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0].calendar_event_id).toBeTruthy();
  });

  it('the compact upcoming-bookings widget also reflects real data', async () => {
    const res = await agent.get('/api/dashboard/bookings/upcoming');
    expect(res.status).toBe(200);
    expect(res.body.bookings.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Knowledge ------------------------------------------------------------
  it('lists knowledge files with real existence/size metadata', async () => {
    const res = await agent.get('/api/dashboard/knowledge');
    expect(res.status).toBe(200);
    expect(res.body.files.map((f: { name: string }) => f.name)).toContain('faq.md');
  });

  it('reads a real allowlisted knowledge file', async () => {
    const res = await agent.get('/api/dashboard/knowledge/faq.md');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe(originalFaqContent);
  });

  it('rejects a knowledge file not on the allowlist, even with a plausible-looking name', async () => {
    const res = await agent.get('/api/dashboard/knowledge/random-other-file.md');
    expect(res.status).toBe(400);
  });

  it('rejects path traversal attempts', async () => {
    const res = await agent.get('/api/dashboard/knowledge/' + encodeURIComponent('../package.json'));
    expect(res.status).toBe(400);
  });

  it('rejects an absolute-path-shaped name', async () => {
    const res = await agent.get('/api/dashboard/knowledge/' + encodeURIComponent('/etc/passwd'));
    expect([400, 404]).toContain(res.status); // never 200 with real file content
  });

  it('saves a valid edit to an allowlisted file, creating a timestamped backup first', async () => {
    const newContent = '# FAQ\n\nUpdated by a dashboard test.\n';
    const res = await agent
      .put('/api/dashboard/knowledge/faq.md')
      .send({ content: newContent });
    expect(res.status).toBe(200);
    expect(res.body.backedUpAs).toBeTruthy();

    const reread = await agent.get('/api/dashboard/knowledge/faq.md');
    expect(reread.body.content).toBe(newContent);
    expect(fs.existsSync(path.join(BACKUP_DIR, res.body.backedUpAs))).toBe(true);
  });

  it('rejects a malformed JSON save for booking.json and does not touch the existing file', async () => {
    const before = fs.existsSync(path.join(KNOWLEDGE_DIR, 'booking.json'))
      ? fs.readFileSync(path.join(KNOWLEDGE_DIR, 'booking.json'), 'utf-8')
      : null;

    const res = await agent
      .put('/api/dashboard/knowledge/booking.json')
      .send({ content: '{ this is not valid json' });
    expect(res.status).toBe(400);

    const after = fs.existsSync(path.join(KNOWLEDGE_DIR, 'booking.json'))
      ? fs.readFileSync(path.join(KNOWLEDGE_DIR, 'booking.json'), 'utf-8')
      : null;
    expect(after).toBe(before); // malformed save must not destroy the previous valid file
  });

  it('rejects a save to a file not on the allowlist', async () => {
    const res = await agent.put('/api/dashboard/knowledge/not-allowed.md').send({ content: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects an oversized save (body-size limit, consistent with the rest of the app)', async () => {
    const res = await agent
      .put('/api/dashboard/knowledge/faq.md')
      .send({ content: 'x'.repeat(300_000) });
    expect(res.status).toBe(413); // caught by the app-wide entity.too.large handler in src/app.ts
  });

  // ---- Services / AI / Integrations / System / Settings ----------------------
  it('services view is derived from services.md, not a second database', async () => {
    const res = await agent.get('/api/dashboard/services');
    expect(res.status).toBe(200);
    expect(res.body.sourceFile).toBe('services.md');
  });

  it('AI config never exposes a secret value', async () => {
    const res = await agent.get('/api/dashboard/ai');
    expect(res.status).toBe(200);
    expect(res.body.providerMode).toBe('mock');
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|Bearer |api[_-]?key/i);
  });

  it('integrations show mock mode and never expose credential values', async () => {
    const res = await agent.get('/api/dashboard/integrations');
    expect(res.status).toBe(200);
    expect(res.body.integrations.every((i: { state: string }) => i.state === 'Development Mock')).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(process.env.WHATSAPP_ACCESS_TOKEN);
  });

  it('system info reports a reachable database and real uptime', async () => {
    const res = await agent.get('/api/dashboard/system');
    expect(res.status).toBe(200);
    expect(res.body.databaseReachable).toBe(true);
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  it('settings view exposes safe config only, never secrets', async () => {
    const res = await agent.get('/api/dashboard/settings');
    expect(res.status).toBe(200);
    expect(res.body.business.timezone).toBeDefined();
    // word-boundary so a safe field name like "restartKeywords" (contains
    // "key" only as a substring, never as its own word) isn't a false match
    expect(JSON.stringify(res.body)).not.toMatch(/\bsecret\b|\btoken\b|\bapi[_-]?key\b/i);
  });

  it('updates a valid settings patch and reflects it immediately, with no restart', async () => {
    const res = await agent
      .put('/api/dashboard/settings')
      .send({ businessName: 'Updated Test Business', bookingDurationMinutes: 45 });
    expect(res.status).toBe(200);
    expect(res.body.business.name).toBe('Updated Test Business');
    expect(res.body.booking.durationMinutes).toBe(45);

    const reread = await agent.get('/api/dashboard/settings');
    expect(reread.body.business.name).toBe('Updated Test Business');
  });

  it('rejects an invalid settings patch and writes nothing', async () => {
    const before = await agent.get('/api/dashboard/settings');
    const res = await agent
      .put('/api/dashboard/settings')
      .send({ businessTimezone: 'Not/A/Real/Zone' });
    expect(res.status).toBe(400);
    expect(res.body.fields).toBeDefined();

    const after = await agent.get('/api/dashboard/settings');
    expect(after.body.business.timezone).toBe(before.body.business.timezone);
  });

  it('settings PUT response never exposes a secret value', async () => {
    const res = await agent.put('/api/dashboard/settings').send({ businessName: 'Formatting Check Business' });
    expect(JSON.stringify(res.body)).not.toMatch(/\bsecret\b|\btoken\b|\bapi[_-]?key\b/i);
  });

  // ---- Credentials (encrypted dashboard override store) ---------------------
  it('reports credential status without ever exposing a raw value', async () => {
    const res = await agent.get('/api/dashboard/credentials');
    expect(res.status).toBe(200);
    expect(res.body.WHATSAPP_ACCESS_TOKEN.source).toBe('env');
    expect(JSON.stringify(res.body)).not.toContain(process.env.WHATSAPP_ACCESS_TOKEN);
  });

  it('sets, masks, tests, and clears a credential override end-to-end', async () => {
    const setRes = await agent
      .put('/api/dashboard/credentials/OPENROUTER_API_KEY')
      .send({ value: 'sk-test-fake-override-key-1234567890' });
    expect(setRes.status).toBe(200);
    expect(setRes.body.masked).not.toContain('sk-test-fake-override-key-1234567890');

    const statusRes = await agent.get('/api/dashboard/credentials');
    expect(statusRes.body.OPENROUTER_API_KEY.source).toBe('override');

    const testRes = await agent.post('/api/dashboard/credentials/OPENROUTER_API_KEY/test');
    expect(typeof testRes.body.ok).toBe('boolean');
    expect(JSON.stringify(testRes.body)).not.toContain('sk-test-fake-override-key-1234567890');

    const clearRes = await agent.delete('/api/dashboard/credentials/OPENROUTER_API_KEY');
    expect(clearRes.status).toBe(200);
    const afterClear = await agent.get('/api/dashboard/credentials');
    expect(afterClear.body.OPENROUTER_API_KEY.source).toBe('env');
  });

  it('rejects an unknown credential key', async () => {
    const res = await agent.put('/api/dashboard/credentials/NOT_A_REAL_KEY').send({ value: 'x' });
    expect(res.status).toBe(400);
  });

  // ---- Project sync --------------------------------------------------------
  it('project-sync view reads real repository coordination state', async () => {
    const res = await agent.get('/api/dashboard/project-sync');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  // ---- Production lockdown: auth-gated, not always-404 -----------------------
  // The dashboard used to 404 unconditionally in production. It is now reachable
  // in production too, but every non-auth route requires a valid session — these
  // two cases replace the old "always 404" behavior.
  async function withProdApp<T>(fn: (prodApp: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
    const envSnapshot = { ...process.env };
    vi.resetModules();
    process.env.NODE_ENV = 'production';
    process.env.WHATSAPP_ACCESS_TOKEN = 'real-token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'real-phone-id';
    process.env.WHATSAPP_VERIFY_TOKEN = 'real-verify-token';
    process.env.META_APP_SECRET = 'real-app-secret';
    process.env.OPENROUTER_API_KEY = 'real-openrouter-key';
    process.env.GOOGLE_CLIENT_EMAIL = 'real@example.iam.gserviceaccount.com';
    process.env.GOOGLE_PRIVATE_KEY = 'real-private-key';
    try {
      const { createApp: createProdApp } = await import('../../src/app');
      return await fn(createProdApp());
    } finally {
      process.env = envSnapshot;
      vi.resetModules();
    }
  }

  it('rejects all dashboard API routes in production without a valid session', async () => {
    await withProdApp(async (prodApp) => {
      // Auth routes themselves must stay reachable — otherwise no one could
      // ever log in to a production deployment.
      const statusRes = await request(prodApp).get('/api/dashboard/auth/status');
      expect(statusRes.status).toBe(200);

      for (const url of ['/api/dashboard/summary', '/api/dashboard/knowledge/faq.md', '/api/dashboard/settings']) {
        const res = await request(prodApp).get(url);
        expect(res.status).toBe(401);
      }
      const putRes = await request(prodApp).put('/api/dashboard/knowledge/faq.md').send({ content: 'x' });
      expect(putRes.status).toBe(401);

      // The static SPA shell stays servable unauthenticated — its own JS is
      // what renders the login screen after checking /auth/status.
      expect((await request(prodApp).get('/dashboard')).status).toBe(200);
      expect((await request(prodApp).get('/')).status).toBe(302);
    });
  });

  it('allows dashboard routes in production with a valid authenticated session', async () => {
    await withProdApp(async (prodApp) => {
      const setup = await request(prodApp)
        .post('/api/dashboard/auth/setup')
        .send({ username: 'prod-admin', password: 'a-very-long-prod-test-password' });
      expect(setup.status).toBe(201);

      // Extract the session cookie manually and attach it explicitly, rather
      // than relying on supertest's automatic cookie jar (request.agent) —
      // the session cookie carries the Secure attribute in production, which
      // a plain in-process HTTP test client will not re-send automatically.
      const setCookieHeader = setup.headers['set-cookie']?.[0] as string;
      expect(setCookieHeader).toBeTruthy();
      const cookiePair = setCookieHeader.split(';')[0];

      const summary = await request(prodApp).get('/api/dashboard/summary').set('Cookie', cookiePair);
      expect(summary.status).toBe(200);

      // A second setup attempt must be permanently refused once an admin exists.
      const secondSetup = await request(prodApp)
        .post('/api/dashboard/auth/setup')
        .send({ username: 'someone-else', password: 'another-long-password-123' });
      expect(secondSetup.status).toBe(409);
    });
  });
});
