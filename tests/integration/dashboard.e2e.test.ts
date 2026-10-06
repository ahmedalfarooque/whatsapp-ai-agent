import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { createApp } from '../../src/app';
import { getOrCreateCustomer } from '../../src/memory/customerRepo';
import { getOrCreateActiveConversation, appendMessage, resetConversation } from '../../src/memory/conversationRepo';
import { acquireLock, confirmLock, markUncertain, buildIdempotencyKey, buildSlotKey } from '../../src/memory/bookingLockRepo';
import { getDb } from '../../src/memory/db';

const KNOWLEDGE_DIR = path.join(__dirname, '..', '..', 'knowledge');
const BACKUP_DIR = path.join(KNOWLEDGE_DIR, '.backups');

describe('dashboard', () => {
  const app = createApp();
  const agent = request.agent(app);
  let customerAId: number;
  let conversationAId: number;
  let originalFaqContent: string;
  let uncertainBookingLockId: number;

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

    const uncertainSlotKey = buildSlotKey('primary', '2099-02-02T10:00:00.000Z', '2099-02-02T10:30:00.000Z');
    const uncertainIdempotencyKey = buildIdempotencyKey(
      conversationAId,
      '2099-02-02T10:00:00.000Z',
      '2099-02-02T10:30:00.000Z',
      'Consult',
    );
    const uncertainLockResult = acquireLock(
      {
        slotKey: uncertainSlotKey,
        idempotencyKey: uncertainIdempotencyKey,
        conversationId: conversationAId,
        startISO: '2099-02-02T10:00:00.000Z',
        endISO: '2099-02-02T10:30:00.000Z',
      },
      db,
    );
    if (uncertainLockResult.acquired) {
      uncertainBookingLockId = uncertainLockResult.lock.id;
      markUncertain(uncertainLockResult.lock.id, db);
    }

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
    expect(page.text).toContain('AI Workspace');
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

  it('lists the seeded uncertain booking', async () => {
    const res = await agent.get('/api/dashboard/bookings?status=uncertain');
    expect(res.status).toBe(200);
    expect(res.body.items.some((b: { id: number }) => b.id === uncertainBookingLockId)).toBe(true);
  });

  it('rejects a reconcile request with an invalid resolution', async () => {
    const res = await agent
      .post(`/api/dashboard/bookings/${uncertainBookingLockId}/reconcile`)
      .send({ resolution: 'something-else' });
    expect(res.status).toBe(400);
  });

  it('rejects reconcile-as-confirmed without a calendarEventId', async () => {
    const res = await agent
      .post(`/api/dashboard/bookings/${uncertainBookingLockId}/reconcile`)
      .send({ resolution: 'confirmed' });
    expect(res.status).toBe(400);
  });

  it('409s reconciling a booking that is not in the uncertain state', async () => {
    const db = getDb();
    const slotKey = buildSlotKey('primary', '2099-03-03T10:00:00.000Z', '2099-03-03T10:30:00.000Z');
    const idempotencyKey = buildIdempotencyKey(
      conversationAId,
      '2099-03-03T10:00:00.000Z',
      '2099-03-03T10:30:00.000Z',
      'Consult',
    );
    const lockResult = acquireLock(
      {
        slotKey,
        idempotencyKey,
        conversationId: conversationAId,
        startISO: '2099-03-03T10:00:00.000Z',
        endISO: '2099-03-03T10:30:00.000Z',
      },
      db,
    );
    if (!lockResult.acquired) throw new Error('setup failed');
    confirmLock(lockResult.lock.id, 'evt_already_confirmed', db);

    const res = await agent
      .post(`/api/dashboard/bookings/${lockResult.lock.id}/reconcile`)
      .send({ resolution: 'not_booked' });
    expect(res.status).toBe(409);
  });

  it('reconciles an uncertain booking as confirmed with a real event id, recorded and never re-appliable', async () => {
    const res = await agent
      .post(`/api/dashboard/bookings/${uncertainBookingLockId}/reconcile`)
      .send({ resolution: 'confirmed', calendarEventId: 'evt_manually_verified' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('confirmed');

    const listed = await agent.get('/api/dashboard/bookings?status=confirmed');
    const reconciled = listed.body.items.find((b: { id: number }) => b.id === uncertainBookingLockId);
    expect(reconciled.calendar_event_id).toBe('evt_manually_verified');

    // Already resolved — a second reconcile attempt is refused, not silently re-applied.
    const second = await agent
      .post(`/api/dashboard/bookings/${uncertainBookingLockId}/reconcile`)
      .send({ resolution: 'not_booked' });
    expect(second.status).toBe(409);
  });

  it('reconciles an uncertain booking as not-booked, freeing the slot for a fresh attempt', async () => {
    const db = getDb();
    const slotKey = buildSlotKey('primary', '2099-04-04T10:00:00.000Z', '2099-04-04T10:30:00.000Z');
    const idempotencyKey = buildIdempotencyKey(
      conversationAId,
      '2099-04-04T10:00:00.000Z',
      '2099-04-04T10:30:00.000Z',
      'Consult',
    );
    const lockResult = acquireLock(
      {
        slotKey,
        idempotencyKey,
        conversationId: conversationAId,
        startISO: '2099-04-04T10:00:00.000Z',
        endISO: '2099-04-04T10:30:00.000Z',
      },
      db,
    );
    if (!lockResult.acquired) throw new Error('setup failed');
    markUncertain(lockResult.lock.id, db);

    const res = await agent
      .post(`/api/dashboard/bookings/${lockResult.lock.id}/reconcile`)
      .send({ resolution: 'not_booked' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('released');

    // The exact same slot/idempotency key can now be claimed again.
    const retry = acquireLock(
      {
        slotKey,
        idempotencyKey,
        conversationId: conversationAId,
        startISO: '2099-04-04T10:00:00.000Z',
        endISO: '2099-04-04T10:30:00.000Z',
      },
      db,
    );
    expect(retry.acquired).toBe(true);
  });

  it('reconcile response never exposes a secret value', async () => {
    const db = getDb();
    const slotKey = buildSlotKey('primary', '2099-05-05T10:00:00.000Z', '2099-05-05T10:30:00.000Z');
    const idempotencyKey = buildIdempotencyKey(
      conversationAId,
      '2099-05-05T10:00:00.000Z',
      '2099-05-05T10:30:00.000Z',
      'Consult',
    );
    const lockResult = acquireLock(
      {
        slotKey,
        idempotencyKey,
        conversationId: conversationAId,
        startISO: '2099-05-05T10:00:00.000Z',
        endISO: '2099-05-05T10:30:00.000Z',
      },
      db,
    );
    if (!lockResult.acquired) throw new Error('setup failed');
    markUncertain(lockResult.lock.id, db);

    const res = await agent
      .post(`/api/dashboard/bookings/${lockResult.lock.id}/reconcile`)
      .send({ resolution: 'confirmed', calendarEventId: 'evt_no_secret_here' });
    expect(JSON.stringify(res.body)).not.toMatch(/\bsecret\b|\btoken\b|\bapi[_-]?key\b/i);
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

  it('records and reports the last connection test result per credential', async () => {
    const before = await agent.get('/api/dashboard/credentials');
    expect(before.body.WHATSAPP_ACCESS_TOKEN.lastCheckedAt).toBeNull();

    const testRes = await agent.post('/api/dashboard/credentials/WHATSAPP_ACCESS_TOKEN/test');
    expect(typeof testRes.body.ok).toBe('boolean');

    const after = await agent.get('/api/dashboard/credentials');
    expect(after.body.WHATSAPP_ACCESS_TOKEN.lastCheckedAt).toBeTruthy();
    expect(after.body.WHATSAPP_ACCESS_TOKEN.lastCheckOk).toBe(testRes.body.ok);
    expect(after.body.WHATSAPP_ACCESS_TOKEN.lastCheckDetail).toBe(testRes.body.detail);
  });

  // ---- Webhook info ----------------------------------------------------------
  it('exposes the real webhook URL matching the actual webhook route, never the verify token value', async () => {
    const res = await agent.get('/api/dashboard/webhook-info');
    expect(res.status).toBe(200);
    expect(res.body.webhookUrl).toMatch(/\/webhook$/);
    expect(typeof res.body.verifyTokenConfigured).toBe('boolean');
    expect(typeof res.body.appSecretConfigured).toBe('boolean');
    expect(JSON.stringify(res.body)).not.toContain(process.env.WHATSAPP_VERIFY_TOKEN);
    expect(JSON.stringify(res.body)).not.toContain(process.env.META_APP_SECRET);
  });

  it('rejects an unauthenticated request to webhook-info', async () => {
    const res = await request(app).get('/api/dashboard/webhook-info');
    expect(res.status).toBe(401);
  });

  // ---- WhatsApp production setup (manual config + Save + Sync) ---------------
  it('rejects Save Configuration when a required field is missing', async () => {
    const res = await agent.post('/api/dashboard/whatsapp/configure').send({
      wabaId: '1111111111',
      phoneNumberId: '2222222222',
      accessToken: 'token_1',
      verifyToken: 'verify_1',
      appSecret: 'secret_1',
      // webhookUrl intentionally omitted
    });
    expect(res.status).toBe(400);
    expect(res.body.fields).toContain('webhookUrl');
  });

  it('rejects Save Configuration with a non-URL webhook value', async () => {
    const res = await agent.post('/api/dashboard/whatsapp/configure').send({
      wabaId: '1111111111',
      phoneNumberId: '2222222222',
      accessToken: 'token_1',
      verifyToken: 'verify_1',
      appSecret: 'secret_1',
      webhookUrl: 'not-a-url',
    });
    expect(res.status).toBe(400);
    expect(res.body.fields).toContain('webhookUrl');
  });

  it('rejects a non-numeric WABA ID or Phone Number ID (e.g. an email a browser autofilled)', async () => {
    const res = await agent.post('/api/dashboard/whatsapp/configure').send({
      wabaId: 'someone@example.com',
      phoneNumberId: '2222222222',
      accessToken: 'token_1',
      verifyToken: 'verify_1',
      appSecret: 'secret_1',
      webhookUrl: 'https://tunnel.example.com/webhook',
    });
    expect(res.status).toBe(400);
    expect(res.body.fields).toContain('wabaId');
  });

  it('Save Configuration persists all six fields and moves status to saved (never live) without echoing secrets', async () => {
    const saveRes = await agent.post('/api/dashboard/whatsapp/configure').send({
      wabaId: '1388480302719892',
      phoneNumberId: '937660752766640',
      accessToken: 'super-secret-token-value',
      verifyToken: 'super-secret-verify-value',
      appSecret: 'super-secret-app-value',
      webhookUrl: 'https://tunnel.example.com/webhook',
    });
    expect(saveRes.status).toBe(200);
    expect(saveRes.body).toEqual({ ok: true, status: 'saved' });
    expect(JSON.stringify(saveRes.body)).not.toContain('super-secret');

    const statusRes = await agent.get('/api/dashboard/whatsapp/status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.syncStatus).toBe('saved');
    expect(statusRes.body.webhookUrl).toBe('https://tunnel.example.com/webhook');
    expect(statusRes.body.wabaId).toBe('1388480302719892');
    expect(statusRes.body.phoneNumberId).toBe('937660752766640');
    expect(statusRes.body.configured).toEqual({
      wabaId: true,
      phoneNumberId: true,
      accessToken: true,
      verifyToken: true,
      appSecret: true,
      webhookUrl: true,
    });
    expect(JSON.stringify(statusRes.body)).not.toContain('super-secret');
  });

  it('Save Configuration with blank secret fields updates WABA ID/Phone/Webhook without clearing previously stored secrets', async () => {
    // Regression test: a real Save Configuration attempt used to be rejected
    // outright (400 "missing" every one of the six fields) whenever a
    // secret field was left blank on a later save — even though secrets had
    // already been saved. Blank must mean "keep the existing value", not
    // "reject the whole request".
    const updateRes = await agent.post('/api/dashboard/whatsapp/configure').send({
      wabaId: '1388480302719892',
      phoneNumberId: '937660752766640',
      accessToken: '',
      verifyToken: '',
      appSecret: '',
      webhookUrl: 'https://updated-tunnel.example.com/webhook',
    });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body).toEqual({ ok: true, status: 'saved' });

    const statusRes = await agent.get('/api/dashboard/whatsapp/status');
    expect(statusRes.body.webhookUrl).toBe('https://updated-tunnel.example.com/webhook');
    // Still configured — the earlier real secret values were preserved, not cleared.
    expect(statusRes.body.configured).toEqual({
      wabaId: true,
      phoneNumberId: true,
      accessToken: true,
      verifyToken: true,
      appSecret: true,
      webhookUrl: true,
    });
  });

  it('never displays the raw .env fallback as a saved WABA ID/Phone Number ID when nothing has been configured', async () => {
    // Regression test: GET /whatsapp/status used to read these two fields
    // via getEffectiveCredential(), which falls back to raw process.env —
    // including the non-empty placeholder env.ts requires at boot in
    // production. That placeholder must never be displayed as if it were a
    // real saved configuration value.
    await agent.delete('/api/dashboard/credentials/WHATSAPP_BUSINESS_ACCOUNT_ID');
    await agent.delete('/api/dashboard/credentials/WHATSAPP_PHONE_NUMBER_ID');
    const statusRes = await agent.get('/api/dashboard/whatsapp/status');
    expect(statusRes.body.wabaId).toBeNull();
    expect(statusRes.body.phoneNumberId).toBeNull();
    expect(statusRes.body.configured.wabaId).toBe(false);
    expect(statusRes.body.configured.phoneNumberId).toBe(false);
  });

  it('Sync WhatsApp performs a real Meta verification and never returns the access token, regardless of outcome', async () => {
    const res = await agent.post('/api/dashboard/whatsapp/sync');
    expect(res.status).toBe(200);
    expect(typeof res.body.ok).toBe('boolean');
    expect(typeof res.body.detail).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain('super-secret-token-value');

    // A real sync attempt (success or failure) is recorded and survives re-read.
    const statusRes = await agent.get('/api/dashboard/whatsapp/status');
    expect(['live', 'failed']).toContain(statusRes.body.syncStatus);
    expect(statusRes.body.lastSyncAt).toBeTruthy();
    expect(statusRes.body.lastSyncDetail).toBe(res.body.detail);
  });

  it('rejects unauthenticated requests to every WhatsApp setup route', async () => {
    const unauth = request(app);
    expect((await unauth.get('/api/dashboard/whatsapp/status')).status).toBe(401);
    expect((await unauth.post('/api/dashboard/whatsapp/configure').send({})).status).toBe(401);
    expect((await unauth.post('/api/dashboard/whatsapp/sync')).status).toBe(401);
  });

  // ---- AI (OpenRouter) simplified save+test ----------------------------------
  it('rejects AI configure without an API key', async () => {
    const res = await agent.post('/api/dashboard/ai/configure').send({ model: 'openrouter/free' });
    expect(res.status).toBe(400);
  });

  it('AI configure persists the key/model and returns a real (non-fabricated) connection result', async () => {
    const res = await agent.post('/api/dashboard/ai/configure').send({ apiKey: 'sk-or-fake-test-key', model: 'openrouter/free' });
    expect(res.status).toBe(200);
    expect(typeof res.body.ok).toBe('boolean');
    expect(typeof res.body.detail).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain('sk-or-fake-test-key');

    const aiRes = await agent.get('/api/dashboard/ai');
    expect(aiRes.body.model).toBe('openrouter/free');
  });

  it('rejects an unauthenticated request to AI configure', async () => {
    const res = await request(app).post('/api/dashboard/ai/configure').send({ apiKey: 'x' });
    expect(res.status).toBe(401);
  });

  // ---- Project sync --------------------------------------------------------
  it('project-sync view reads real repository coordination state', async () => {
    const res = await agent.get('/api/dashboard/project-sync');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
  });

  // ---- Logout-all (MUST run last: revokes every session, including `agent`'s) --
  describe('reply templates, menu tree and WhatsApp requests', () => {
    it('lists the shipped Rowad Alfa templates with published live text and no legacy "welcome" row', async () => {
      const res = await agent.get('/api/dashboard/templates');
      expect(res.status).toBe(200);
      const keys = res.body.templates.map((x: { key: string }) => x.key);
      for (const k of ['language_selection', 'main_menu', 'car_audio', 'car_audio_7', 'tinting_protection', 'prices_enquiries', 'appointment_intro', 'quotation_confirm', 'human_support']) expect(keys).toContain(k);
      expect(keys).not.toContain('welcome');
      const menu = res.body.templates.find((x: { key: string }) => x.key === 'main_menu');
      expect(menu.liveEn).toContain('9️⃣ About Rowad Alfa');
      expect(menu.liveAr).toContain('9️⃣ معلومات عن رواد ألفا');
    });

    it('preview renders with the live resolver, substitutes sample placeholders and includes the automatic follow-up bubble', async () => {
      const res = await agent
        .post('/api/dashboard/templates/invalid_option/preview')
        .send({ ar: 'خيار غير صحيح يا {name}', en: 'Invalid choice, {name}. Ref {reference}' });
      expect(res.status).toBe(200);
      expect(res.body.en).toBe('Invalid choice, Ahmed. Ref APT-2026-1234');
      expect(res.body.ar).toBe('خيار غير صحيح يا Ahmed');
      expect(res.body.followUp.en.key).toBe('main_menu');
      expect(res.body.followUp.en.text).toContain('How can we help you today?');
      expect(res.body.followUp.ar.text).toContain('كيف يمكننا خدمتك اليوم؟');
      const plain = await agent.post('/api/dashboard/templates/car_audio/preview').send({ ar: 'أ', en: 'a' });
      expect(plain.body.followUp.en).toBeNull();
    });

    it('exposes the router menu tree so the dashboard flow map cannot drift from the live routing', async () => {
      const res = await agent.get('/api/dashboard/menu-tree');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.mainMenu)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
      expect(res.body.mainMenu['7']).toEqual({ flow: 'appointment' });
      expect(res.body.mainMenu['8']).toEqual({ handoff: true });
      expect(res.body.submenus.SUBMENU_PRICES.options['4']).toEqual({ flow: 'quotation' });
      expect(res.body.flows.appointment.steps).toHaveLength(8);
      expect(res.body.followUps.invalid_option).toBe('main_menu');
    });

    it('lists WhatsApp-collected requests and lets staff move them through statuses', async () => {
      const { createCustomerRequest } = await import('../../src/memory/customerRequestRepo');
      const created = createCustomerRequest({ customerId: customerAId, waId: '15550001111', kind: 'quotation', payload: { name: 'Alice', vehicle: 'Camry 2024' } });
      const list = await agent.get('/api/dashboard/requests?kind=quotation');
      expect(list.status).toBe(200);
      expect(list.body.pending).toBeGreaterThanOrEqual(1);
      const row = list.body.requests.find((r: { id: number }) => r.id === created.id);
      expect(row.reference).toMatch(/^INQ-/);
      expect(row.payload).toEqual({ name: 'Alice', vehicle: 'Camry 2024' });
      const automation = await agent.get('/api/dashboard/automation');
      expect(automation.body.pendingRequests).toBeGreaterThanOrEqual(1);

      const bad = await agent.post(`/api/dashboard/requests/${created.id}/status`).send({ status: 'bogus' });
      expect(bad.status).toBe(400);
      const ok = await agent.post(`/api/dashboard/requests/${created.id}/status`).send({ status: 'contacted' });
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe('contacted');
      expect(ok.body.changed).toBe(true);
      expect(ok.body.event).toMatchObject({ old_status: 'pending', new_status: 'contacted', actor: 'dashboard' });
      expect(ok.body.events).toHaveLength(1);
      // customer notification queued (status_update template), delivery pending because no WhatsApp session in tests
      expect(ok.body.notifications.some((n: { kind: string; status: string }) => n.kind === 'customer_status' && n.status === 'pending')).toBe(true);
      const same = await agent.post(`/api/dashboard/requests/${created.id}/status`).send({ status: 'contacted' });
      expect(same.body.changed).toBe(false);
      const confirmed = await agent.post(`/api/dashboard/requests/${created.id}/status`).send({ status: 'confirmed' });
      expect(confirmed.body.notifications.filter((n: { kind: string }) => n.kind === 'customer_status')).toHaveLength(2);
      const withTimeline = await agent.get('/api/dashboard/requests');
      expect(withTimeline.body.statuses).toContain('rejected');
      expect(withTimeline.body.requests.find((r: { id: number }) => r.id === created.id).events).toHaveLength(2);
      const notifications = await agent.get('/api/dashboard/notifications');
      expect(notifications.status).toBe(200);
      expect(notifications.body.summary.pending).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(notifications.body)).not.toContain('15550001111'); // customer number masked
      const flush = await agent.post('/api/dashboard/notifications/flush');
      expect(flush.status).toBe(200);
      expect(flush.body.delivered).toBe(0); // no session in tests → stays pending, never lost
      const missing = await agent.post('/api/dashboard/requests/999999/status').send({ status: 'closed' });
      expect(missing.status).toBe(404);
    });
  });

  it('every GET endpoint the dashboard pages call answers 200 with a JSON object (no page can crash on a missing route)', async () => {
    const endpoints = [
      '/api/dashboard/summary', '/api/dashboard/status', '/api/dashboard/system', '/api/dashboard/settings', '/api/dashboard/ai', '/api/dashboard/integrations',
      '/api/dashboard/credentials', '/api/dashboard/knowledge', '/api/dashboard/services', '/api/dashboard/project-sync', '/api/dashboard/webhook-info',
      '/api/dashboard/whatsapp/status', '/api/dashboard/whatsapp/qr', '/api/dashboard/automation', '/api/dashboard/automation/activity', '/api/dashboard/support-queue',
      '/api/dashboard/customers', '/api/dashboard/conversations', '/api/dashboard/conversations-recent', '/api/dashboard/bookings', '/api/dashboard/bookings/upcoming',
      '/api/dashboard/templates', '/api/dashboard/templates/location_hours', '/api/dashboard/menu-tree', '/api/dashboard/requests', '/api/dashboard/documents',
      '/api/dashboard/offers', '/api/dashboard/business-profile',
    ];
    for (const url of endpoints) {
      const res = await agent.get(url);
      expect(res.status, url).toBe(200);
      expect(typeof res.body, url).toBe('object');
    }
    // the two pages that crashed read these exact keys
    const profile = await agent.get('/api/dashboard/business-profile');
    expect(profile.body.settings).toHaveProperty('businessName');
    expect(profile.body.settings).toHaveProperty('businessHoursStart');
    expect(profile.body.rendered).toHaveProperty('hoursEn');
    // Rowad Alfa location defaults (seeded at boot on the real DB) reach the live location reply — no dangling labels, no raw placeholders
    const { seedBusinessProfileDefaults } = await import('../../src/config/businessSettings');
    seedBusinessProfileDefaults();
    const tpl = await agent.get('/api/dashboard/templates/location_hours');
    const preview = await agent.post('/api/dashboard/templates/location_hours/preview').send({ ar: tpl.body.liveAr, en: tpl.body.liveEn });
    expect(preview.body.en).toContain('Jeddah / Bahrah');
    expect(preview.body.en).toContain('https://maps.app.goo.gl/8sxNK9wMNsTucvCh7');
    expect(preview.body.en).toContain('Saturday to Thursday: 9:00 AM - 10:00 PM');
    expect(preview.body.en).toContain('Friday: 4:00 PM - 10:00 PM');
    expect(preview.body.en).toContain('Free dedicated customer parking');
    expect(preview.body.en).not.toMatch(/\{[a-z]+\}/);
    expect(preview.body.ar).toContain('من السبت إلى الخميس');
  });

  describe('business profile, documents and offers', () => {
    it('business profile: reads a flat settings object (no more undefined.businessName), validates and publishes immediately', async () => {
      const res = await agent.get('/api/dashboard/business-profile');
      expect(res.status).toBe(200);
      expect(res.body.settings.businessName).toBeTruthy();
      expect(res.body.settings.googleMapsUrl).toBe('https://maps.app.goo.gl/8sxNK9wMNsTucvCh7');
      expect(res.body.rendered.hoursEn).toContain(':');
      const bad = await agent.put('/api/dashboard/business-profile').send({ googleMapsUrl: 'ftp://x', latitude: 999 });
      expect(bad.status).toBe(400);
      expect(bad.body.fields).toHaveProperty('googleMapsUrl');
      expect(bad.body.fields).toHaveProperty('latitude');
      const ok = await agent.put('/api/dashboard/business-profile').send({ addressEn: 'Bahrah, Jeddah', businessNameAr: 'رواد ألفا للعناية بالسيارات', fridayHoursStart: '16:00', fridayHoursEnd: '22:00' });
      expect(ok.status).toBe(200);
      expect(ok.body.settings.addressEn).toBe('Bahrah, Jeddah');
      expect(ok.body.rendered.hoursEn).toContain('Friday');
      // the live location template now carries the published values — same resolver as WhatsApp
      const preview = await agent.post('/api/dashboard/templates/location_hours/preview').send({ ar: '{address} {maps}', en: '{address} {maps}' });
      expect(preview.body.en).toBe('Bahrah, Jeddah https://maps.app.goo.gl/8sxNK9wMNsTucvCh7');
      expect(preview.body.sourceType).toBe('data-driven');
    });

    it('documents: uploads with validation, hides storage paths, serves HTML as plain text, patches visibility, deletes', async () => {
      const upload = await agent.post('/api/dashboard/documents').set('Content-Type', 'text/html').set('X-File-Name', encodeURIComponent('site.html')).set('X-Visibility', 'customer').set('X-Title', encodeURIComponent('Brochure')).send(Buffer.from('<p>Hello <script>x()</script>world</p>'));
      expect(upload.status).toBe(201);
      expect(upload.body.stored_name).toBeUndefined();
      expect(upload.body.title).toBe('Brochure');
      expect(upload.body.processing).toBe('text_extracted');
      const id = upload.body.id as number;
      const file = await agent.get(`/api/dashboard/documents/${id}/file`);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toContain('text/plain');
      expect(file.headers['content-security-policy']).toContain('sandbox');
      expect(file.text).toContain('<script>'); // raw bytes preserved, but never executable
      const rejected = await agent.post('/api/dashboard/documents').set('Content-Type', 'application/octet-stream').set('X-File-Name', 'malware.exe').send(Buffer.from('MZ'));
      expect(rejected.status).toBe(400);
      const fakePdf = await agent.post('/api/dashboard/documents').set('Content-Type', 'application/pdf').set('X-File-Name', 'x.pdf').send(Buffer.from('not really'));
      expect(fakePdf.status).toBe(400);
      const patched = await agent.patch(`/api/dashboard/documents/${id}`).send({ visibility: 'internal', status: 'archived' });
      expect(patched.body.visibility).toBe('internal');
      expect(patched.body.status).toBe('archived');
      const list = await agent.get('/api/dashboard/documents');
      expect(list.body.documents.some((d: { id: number }) => d.id === id)).toBe(true);
      expect(list.body.limits.allowed).toContain('pdf');
      expect((await agent.delete(`/api/dashboard/documents/${id}`)).status).toBe(200);
      expect((await agent.get(`/api/dashboard/documents/${id}/file`)).status).toBe(404);
    });

    it('offers: create → publish → visible to customers and in the prices preview → finish → hidden; validation and soft delete', async () => {
      const created = await agent.post('/api/dashboard/offers').send({ titleAr: 'عرض', titleEn: 'E2E tint offer', descriptionEn: 'Ceramic tint', priceStatus: 'on_request', promotionalPrice: 999 });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe('draft');
      expect(created.body.promotional_price).toBeNull(); // unverified → no numbers stored
      const id = created.body.id as number;
      let list = await agent.get('/api/dashboard/offers');
      expect(list.body.customerVisible).not.toContain(id);
      expect(list.body.kpis.draft).toBeGreaterThanOrEqual(1);
      const noOffers = await agent.post('/api/dashboard/templates/prices_offers_list/preview').send({ ar: '{offers}', en: '{offers}' });
      expect(noOffers.body.fallback.en.key).toBe('prices_offers');
      expect((await agent.post(`/api/dashboard/offers/${id}/publish`)).body.effectiveStatus).toBe('published');
      list = await agent.get('/api/dashboard/offers');
      expect(list.body.customerVisible).toContain(id);
      expect(list.body.preview.en.join('\n')).toContain('🌟 E2E tint offer');
      const withOffers = await agent.post('/api/dashboard/templates/prices_offers_list/preview').send({ ar: '{offers}', en: '{offers}' });
      expect(withOffers.body.en).toContain('E2E tint offer');
      expect(withOffers.body.fallback.en).toBeNull();
      const dup = await agent.post(`/api/dashboard/offers/${id}/duplicate`);
      expect(dup.body.title_en).toBe('E2E tint offer (copy)');
      expect((await agent.post(`/api/dashboard/offers/${id}/finish`)).body.effectiveStatus).toBe('finished');
      list = await agent.get('/api/dashboard/offers');
      expect(list.body.customerVisible).not.toContain(id);
      expect(list.body.offers.some((o: { id: number }) => o.id === id)).toBe(true); // finished record preserved
      const invalid = await agent.post('/api/dashboard/offers').send({ titleEn: 'no arabic' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.fields).toHaveProperty('titleAr');
      expect((await agent.post(`/api/dashboard/offers/${id}/bogus`)).status).toBe(404);
      expect((await agent.delete(`/api/dashboard/offers/${id}`)).status).toBe(200);
      expect((await agent.get(`/api/dashboard/offers/${id}`)).status).toBe(404);
      await agent.delete(`/api/dashboard/offers/${dup.body.id}`);
    });

    it('QR connection actions: status/refresh/retry answer with a notice and never expose credentials', async () => {
      const res = await agent.post('/api/dashboard/whatsapp/qr/status');
      // In tests QR is unavailable (NODE_ENV=test) so actions that need a socket 409; "status" is a pure read.
      expect([200, 409]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.diagnostics.pid).toBe(process.pid);
        expect(JSON.stringify(res.body)).not.toMatch(/creds|noiseKey|signedIdentityKey/);
      }
    });
  });

  it('logout-all revokes every active session, including the caller\'s own', async () => {
    const secondAgent = request.agent(app);
    const login = await secondAgent
      .post('/api/dashboard/auth/login')
      .send({ username: 'test-admin', password: 'a-very-long-test-password-123' });
    expect(login.status).toBe(200);
    expect((await secondAgent.get('/api/dashboard/summary')).status).toBe(200);

    const res = await agent.post('/api/dashboard/auth/logout-all');
    expect(res.status).toBe(200);
    expect(res.body.revoked).toBeGreaterThanOrEqual(2);

    expect((await agent.get('/api/dashboard/summary')).status).toBe(401);
    expect((await secondAgent.get('/api/dashboard/summary')).status).toBe(401);
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
