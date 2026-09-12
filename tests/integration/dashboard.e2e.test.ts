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
  let customerAId: number;
  let conversationAId: number;
  let originalFaqContent: string;

  beforeAll(() => {
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

  // ---- Root / shell ------------------------------------------------------
  it('redirects the root route to the dashboard', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/dashboard');
  });

  it('serves the dashboard shell with working navigation links, and no dead "#" hrefs', async () => {
    const page = await request(app).get('/dashboard');
    expect(page.status).toBe(200);
    expect(page.text).toContain('WhatsApp AI Agent');
    expect(page.text).toContain('id="view"');
    // every nav item must be a real hash route, not a bare "#" placeholder
    const hrefMatches = [...page.text.matchAll(/href="(#[^"]*)"/g)].map((m) => m[1]);
    expect(hrefMatches.length).toBeGreaterThan(5);
    expect(hrefMatches.every((href) => href.length > 1)).toBe(true);
  });

  it('serves the dashboard static assets referenced by the shell', async () => {
    const script = await request(app).get('/dashboard/app.js');
    expect(script.status).toBe(200);
    const style = await request(app).get('/dashboard/styles.css');
    expect(style.status).toBe(200);
  });

  it('does not change health and readiness routes', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
    expect((await request(app).get('/readiness')).status).toBe(200);
  });

  // ---- Summary / status ---------------------------------------------------
  it('summary reflects real database counts, not a fixed placeholder', async () => {
    const summary = await request(app).get('/api/dashboard/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.customers).toBeGreaterThanOrEqual(2);
    expect(summary.body.conversations).toBeGreaterThanOrEqual(2);
    expect(summary.body.bookings).toBeGreaterThanOrEqual(1); // fixed: reads booking_locks, not the unused booking_sessions table
  });

  it('status reports provider mode and knowledge file presence', async () => {
    const status = await request(app).get('/api/dashboard/status');
    expect(status.status).toBe(200);
    expect(status.body.providerMode).toBe('mock');
    expect(Array.isArray(status.body.services)).toBe(true);
    expect(Array.isArray(status.body.knowledge)).toBe(true);
  });

  // ---- Customers --------------------------------------------------------
  it('lists customers with real conversation/booking counts', async () => {
    const res = await request(app).get('/api/dashboard/customers');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(2);
    const alice = res.body.items.find((c: { id: number }) => c.id === customerAId);
    expect(alice.conversationCount).toBeGreaterThanOrEqual(1);
    expect(alice.bookingCount).toBeGreaterThanOrEqual(1);
  });

  it('search filters customers by name/number', async () => {
    const res = await request(app).get('/api/dashboard/customers?search=Alice');
    expect(res.status).toBe(200);
    expect(res.body.items.every((c: { display_name: string }) => c.display_name?.includes('Alice'))).toBe(true);

    const none = await request(app).get('/api/dashboard/customers?search=NoSuchCustomerXYZ');
    expect(none.body.items).toEqual([]);
  });

  it('paginates customers and never exceeds the max page size', async () => {
    const res = await request(app).get('/api/dashboard/customers?limit=999&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(100);
  });

  it('returns a real customer detail record', async () => {
    const res = await request(app).get(`/api/dashboard/customers/${customerAId}`);
    expect(res.status).toBe(200);
    expect(res.body.wa_id).toBe('15550001111');
    expect(res.body.conversationCount).toBeGreaterThanOrEqual(1);
  });

  it('returns 404 for a customer id that does not exist', async () => {
    const res = await request(app).get('/api/dashboard/customers/999999');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a non-numeric customer id (not a raw SQL/stack trace leak)', async () => {
    const res = await request(app).get('/api/dashboard/customers/not-a-number');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at\s+\w+\s+\(/);
  });

  // ---- Conversations ------------------------------------------------------
  it('lists conversations with message counts', async () => {
    const res = await request(app).get('/api/dashboard/conversations');
    expect(res.status).toBe(200);
    const convo = res.body.items.find((c: { id: number }) => c.id === conversationAId);
    expect(convo.messageCount).toBeGreaterThanOrEqual(2);
  });

  it('filters conversations by status', async () => {
    const activeOnly = await request(app).get('/api/dashboard/conversations?status=active');
    expect(activeOnly.body.items.every((c: { status: string }) => c.status === 'active')).toBe(true);
  });

  it('returns real chronological messages for a conversation detail, never fabricated', async () => {
    const res = await request(app).get(`/api/dashboard/conversations/${conversationAId}`);
    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2);
    expect(res.body.messages[0].role).toBe('user');
    expect(res.body.messages[0].content).toContain('what are your hours');
  });

  it('returns 404 for a conversation that does not exist', async () => {
    const res = await request(app).get('/api/dashboard/conversations/999999');
    expect(res.status).toBe(404);
  });

  it('shows an ended conversation correctly after a restart, without losing history', async () => {
    resetConversation(customerAId);
    const res = await request(app).get(`/api/dashboard/conversations/${conversationAId}`);
    expect(res.body.conversation.status).toBe('ended');
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2); // history preserved, not deleted
  });

  // ---- Bookings -----------------------------------------------------------
  it('lists real confirmed bookings from booking_locks', async () => {
    const res = await request(app).get('/api/dashboard/bookings?status=confirmed');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.items[0].calendar_event_id).toBeTruthy();
  });

  it('the compact upcoming-bookings widget also reflects real data', async () => {
    const res = await request(app).get('/api/dashboard/bookings/upcoming');
    expect(res.status).toBe(200);
    expect(res.body.bookings.length).toBeGreaterThanOrEqual(1);
  });

  // ---- Knowledge ------------------------------------------------------------
  it('lists knowledge files with real existence/size metadata', async () => {
    const res = await request(app).get('/api/dashboard/knowledge');
    expect(res.status).toBe(200);
    expect(res.body.files.map((f: { name: string }) => f.name)).toContain('faq.md');
  });

  it('reads a real allowlisted knowledge file', async () => {
    const res = await request(app).get('/api/dashboard/knowledge/faq.md');
    expect(res.status).toBe(200);
    expect(res.body.content).toBe(originalFaqContent);
  });

  it('rejects a knowledge file not on the allowlist, even with a plausible-looking name', async () => {
    const res = await request(app).get('/api/dashboard/knowledge/random-other-file.md');
    expect(res.status).toBe(400);
  });

  it('rejects path traversal attempts', async () => {
    const res = await request(app).get('/api/dashboard/knowledge/' + encodeURIComponent('../package.json'));
    expect(res.status).toBe(400);
  });

  it('rejects an absolute-path-shaped name', async () => {
    const res = await request(app).get('/api/dashboard/knowledge/' + encodeURIComponent('/etc/passwd'));
    expect([400, 404]).toContain(res.status); // never 200 with real file content
  });

  it('saves a valid edit to an allowlisted file, creating a timestamped backup first', async () => {
    const newContent = '# FAQ\n\nUpdated by a dashboard test.\n';
    const res = await request(app)
      .put('/api/dashboard/knowledge/faq.md')
      .send({ content: newContent });
    expect(res.status).toBe(200);
    expect(res.body.backedUpAs).toBeTruthy();

    const reread = await request(app).get('/api/dashboard/knowledge/faq.md');
    expect(reread.body.content).toBe(newContent);
    expect(fs.existsSync(path.join(BACKUP_DIR, res.body.backedUpAs))).toBe(true);
  });

  it('rejects a malformed JSON save for booking.json and does not touch the existing file', async () => {
    const before = fs.existsSync(path.join(KNOWLEDGE_DIR, 'booking.json'))
      ? fs.readFileSync(path.join(KNOWLEDGE_DIR, 'booking.json'), 'utf-8')
      : null;

    const res = await request(app)
      .put('/api/dashboard/knowledge/booking.json')
      .send({ content: '{ this is not valid json' });
    expect(res.status).toBe(400);

    const after = fs.existsSync(path.join(KNOWLEDGE_DIR, 'booking.json'))
      ? fs.readFileSync(path.join(KNOWLEDGE_DIR, 'booking.json'), 'utf-8')
      : null;
    expect(after).toBe(before); // malformed save must not destroy the previous valid file
  });

  it('rejects a save to a file not on the allowlist', async () => {
    const res = await request(app).put('/api/dashboard/knowledge/not-allowed.md').send({ content: 'x' });
    expect(res.status).toBe(400);
  });

  it('rejects an oversized save (body-size limit, consistent with the rest of the app)', async () => {
    const res = await request(app)
      .put('/api/dashboard/knowledge/faq.md')
      .send({ content: 'x'.repeat(300_000) });
    expect(res.status).toBe(413); // caught by the app-wide entity.too.large handler in src/app.ts
  });

  // ---- Services / AI / Integrations / System / Settings ----------------------
  it('services view is derived from services.md, not a second database', async () => {
    const res = await request(app).get('/api/dashboard/services');
    expect(res.status).toBe(200);
    expect(res.body.sourceFile).toBe('services.md');
  });

  it('AI config never exposes a secret value', async () => {
    const res = await request(app).get('/api/dashboard/ai');
    expect(res.status).toBe(200);
    expect(res.body.providerMode).toBe('mock');
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|Bearer |api[_-]?key/i);
  });

  it('integrations show mock mode and never expose credential values', async () => {
    const res = await request(app).get('/api/dashboard/integrations');
    expect(res.status).toBe(200);
    expect(res.body.integrations.every((i: { state: string }) => i.state === 'Development Mock')).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(process.env.WHATSAPP_ACCESS_TOKEN);
  });

  it('system info reports a reachable database and real uptime', async () => {
    const res = await request(app).get('/api/dashboard/system');
    expect(res.status).toBe(200);
    expect(res.body.databaseReachable).toBe(true);
    expect(typeof res.body.uptimeSeconds).toBe('number');
  });

  it('settings view exposes safe config only, never secrets', async () => {
    const res = await request(app).get('/api/dashboard/settings');
    expect(res.status).toBe(200);
    expect(res.body.business.timezone).toBeDefined();
    // word-boundary so a safe field name like "restartKeywords" (contains
    // "key" only as a substring, never as its own word) isn't a false match
    expect(JSON.stringify(res.body)).not.toMatch(/\bsecret\b|\btoken\b|\bapi[_-]?key\b/i);
  });

  // ---- Project sync --------------------------------------------------------
  it('project-sync view reads real repository coordination state', async () => {
    const res = await request(app).get('/api/dashboard/project-sync');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  // ---- Production lockdown -------------------------------------------------
  it('disables every dashboard route in production mode, including new API/knowledge routes', async () => {
    const envSnapshot = { ...process.env };
    try {
      vi.resetModules();
      process.env.NODE_ENV = 'production';
      process.env.WHATSAPP_ACCESS_TOKEN = 'real-token';
      process.env.WHATSAPP_PHONE_NUMBER_ID = 'real-phone-id';
      process.env.WHATSAPP_VERIFY_TOKEN = 'real-verify-token';
      process.env.META_APP_SECRET = 'real-app-secret';
      process.env.OPENROUTER_API_KEY = 'real-openrouter-key';
      process.env.GOOGLE_CLIENT_EMAIL = 'real@example.iam.gserviceaccount.com';
      process.env.GOOGLE_PRIVATE_KEY = 'real-private-key';

      const { createApp: createProdApp } = await import('../../src/app');
      const prodApp = createProdApp();

      for (const url of ['/', '/dashboard', '/api/dashboard/summary', '/api/dashboard/knowledge/faq.md']) {
        const res = await request(prodApp).get(url);
        expect(res.status).toBe(404);
      }
      const putRes = await request(prodApp).put('/api/dashboard/knowledge/faq.md').send({ content: 'x' });
      expect(putRes.status).toBe(404);
    } finally {
      process.env = envSnapshot;
      vi.resetModules();
    }
  });
});
