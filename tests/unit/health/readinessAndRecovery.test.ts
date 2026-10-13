import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHealthRouter } from '../../../src/health/router';
import { heartbeat, noteInbound, noteProcessed, resetHeartbeatForTests } from '../../../src/health/heartbeat';
import { getDb } from '../../../src/memory/db';
import { createAccount, setAccountStatus } from '../../../src/accounts/accountRepo';
import { claimWebhookEvent, markWebhookEventProcessed, markWebhookEventFailed, recoverInterruptedEvents } from '../../../src/memory/webhookEventRepo';

/**
 * 24/7 evidence an operator can read without logs: /readiness reports every enabled account's real connection state (a disconnected
 * account is 'degraded', never pretended ready) and the worker heartbeat; a boot sweep turns events interrupted by a restart into
 * recorded failures instead of silence. Disposable in-memory database.
 */
const app = express();
app.use(createHealthRouter());

beforeEach(() => { getDb(); resetHeartbeatForTests(); });

describe('/readiness', () => {
  it('reports accounts, which are not connected, and the worker heartbeat; degraded when an enabled account cannot receive messages', async () => {
    const a = createAccount({ name: 'Ready Co' }).id;
    const b = createAccount({ name: 'Unpaired Co' }).id;
    setAccountStatus(a, 'connected');
    setAccountStatus(b, 'qr_required');
    noteInbound(a, 1_000_000);
    noteProcessed(a, 1_000_500);
    const res = await request(app).get('/readiness');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.notConnected).toContain(b);
    expect(res.body.accounts.find((x: { id: number }) => x.id === a)).toMatchObject({ status: 'connected', connected: true });
    expect(res.body.accounts.find((x: { id: number }) => x.id === b)).toMatchObject({ status: 'qr_required', connected: false });
    expect(res.body.workers.perAccount.find((x: { accountId: number }) => x.accountId === a)).toEqual({ accountId: a, lastInboundAt: new Date(1_000_000).toISOString(), lastProcessedAt: new Date(1_000_500).toISOString() });
    expect(typeof res.body.workers.uptimeSeconds).toBe('number');
    expect(JSON.stringify(res.body)).not.toMatch(/sk-or|password|creds/);
  });

  it('is ready when every enabled account is connected; a disabled account does not count', async () => {
    for (const acc of getDb().prepare('SELECT id FROM whatsapp_accounts').all() as Array<{ id: number }>) setAccountStatus(acc.id, 'connected');
    const off = createAccount({ name: 'Off Co' }).id;
    getDb().prepare('UPDATE whatsapp_accounts SET enabled = 0 WHERE id = ?').run(off);
    const res = await request(app).get('/readiness');
    expect(res.body.status).toBe('ready');
    expect(res.body.notConnected).toEqual([]);
    expect(heartbeat().lastInboundAt).toBeNull();
  });
});

describe('recoverInterruptedEvents (boot sweep)', () => {
  it('marks only old events that were claimed but never finished; processed, failed and fresh events are untouched; a replay is still refused', () => {
    const db = getDb();
    db.prepare('DELETE FROM webhook_events').run();
    claimWebhookEvent('qr:2:old-interrupted', 'x');
    claimWebhookEvent('qr:2:old-done', 'x');
    claimWebhookEvent('qr:2:old-failed', 'x');
    claimWebhookEvent('qr:2:fresh', 'x');
    markWebhookEventProcessed('qr:2:old-done');
    markWebhookEventFailed('qr:2:old-failed', 'provider down');
    db.prepare("UPDATE webhook_events SET received_at = datetime('now', '-10 minutes') WHERE message_id LIKE 'qr:2:old-%'").run();
    expect(recoverInterruptedEvents(120)).toEqual(['qr:2:old-interrupted']);
    const rows = Object.fromEntries((db.prepare('SELECT message_id, processed_at, error FROM webhook_events').all() as Array<{ message_id: string; processed_at: string | null; error: string | null }>).map((r) => [r.message_id, r]));
    expect(rows['qr:2:old-interrupted']!.error).toMatch(/interrupted by a restart/);
    expect(rows['qr:2:old-done']!.error).toBeNull();
    expect(rows['qr:2:old-failed']!.error).toBe('provider down');
    expect(rows['qr:2:fresh']!.error).toBeNull();
    expect(recoverInterruptedEvents(120)).toEqual([]); // idempotent
    expect(claimWebhookEvent('qr:2:old-interrupted', 'x')).toBe(false); // never processed twice
  });
});
