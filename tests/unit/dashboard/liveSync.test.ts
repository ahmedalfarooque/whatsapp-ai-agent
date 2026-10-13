import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// The live-sync contract of the dashboard (ui-kit.js): the measured refresh interval, backoff, stale-snapshot protection and the footer label.
const DASH = path.resolve(__dirname, '..', '..', '..', 'dashboard');
const source = fs.readFileSync(path.join(DASH, 'ui-kit.js'), 'utf8');
const sandbox: { globalThis?: unknown; UiKit?: any } = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(source, sandbox);
const kit = sandbox.UiKit!;

describe('refresh interval and backoff', () => {
  it('polls every 10 s while visible and every 60 s while hidden; failures double the delay up to 2 minutes; a success resets it', () => {
    expect(kit.syncDelay({ hidden: false, failures: 0 })).toBe(10000);
    expect(kit.syncDelay({ hidden: true, failures: 0 })).toBe(60000);
    expect(kit.syncDelay({ hidden: false, failures: 1 })).toBe(20000);
    expect(kit.syncDelay({ hidden: false, failures: 2 })).toBe(40000);
    expect(kit.syncDelay({ hidden: false, failures: 9 })).toBe(120000);
    expect(kit.syncDelay({ hidden: true, failures: 3 })).toBe(120000);
  });
});

describe('stale snapshots never overwrite newer ones', () => {
  it('a response generated earlier than the last applied snapshot is ignored; equal or newer is applied; missing times are tolerated', () => {
    expect(kit.isNewerSnapshot('2026-10-13T10:00:00Z', '2026-10-13T09:59:59Z')).toBe(false);
    expect(kit.isNewerSnapshot('2026-10-13T10:00:00Z', '2026-10-13T10:00:00Z')).toBe(true);
    expect(kit.isNewerSnapshot('2026-10-13T10:00:00Z', '2026-10-13T10:00:01Z')).toBe(true);
    expect(kit.isNewerSnapshot('', '2026-10-13T10:00:01Z')).toBe(true);
    expect(kit.isNewerSnapshot('2026-10-13T10:00:00Z', undefined)).toBe(false);
    expect(kit.isNewerSnapshot('garbage', '2026-10-13T10:00:01Z')).toBe(true);
  });

  it('the signature changes for a new account, a renamed one, a state change, a disabled one or a new number — and only then', () => {
    const base = [{ id: 1, name: 'A', enabled: true, uiStatus: 'connected', phoneNumber: '+1' }, { id: 2, name: 'B', enabled: true, uiStatus: 'qr_required', phoneNumber: null }];
    const sig = kit.accountsSignature(base);
    expect(kit.accountsSignature(JSON.parse(JSON.stringify(base)))).toBe(sig);
    expect(kit.accountsSignature([...base, { id: 3, name: 'C', enabled: true, uiStatus: 'qr_required' }])).not.toBe(sig);
    expect(kit.accountsSignature([{ ...base[0], uiStatus: 'disconnected' }, base[1]])).not.toBe(sig);
    expect(kit.accountsSignature([{ ...base[0], enabled: false }, base[1]])).not.toBe(sig);
    expect(kit.accountsSignature([{ ...base[0], name: 'A2' }, base[1]])).not.toBe(sig);
    expect(kit.accountsSignature([base[0], { ...base[1], phoneNumber: '+2' }])).not.toBe(sig);
  });
});

describe('footer label', () => {
  const t0 = Date.parse('2026-10-13T10:00:00Z');
  it('says live, stale (after 30 s) or error with the age of the last good sync, and never hides a failure', () => {
    expect(kit.syncLabel({ lastOkAt: 0, failures: 0 }, t0)).toEqual({ tone: 'pending', text: 'Syncing…' });
    expect(kit.syncLabel({ lastOkAt: 0, failures: 2 }, t0)).toEqual({ tone: 'error', text: 'Sync failed — retrying' });
    expect(kit.syncLabel({ lastOkAt: t0 - 3000, failures: 0 }, t0)).toEqual({ tone: 'ok', text: 'Live · synced just now' });
    expect(kit.syncLabel({ lastOkAt: t0 - 12000, failures: 0 }, t0)).toEqual({ tone: 'ok', text: 'Live · synced 12 s ago' });
    expect(kit.syncLabel({ lastOkAt: t0 - 45000, failures: 0 }, t0)).toEqual({ tone: 'stale', text: 'Stale — last synced 45 s ago' });
    expect(kit.syncLabel({ lastOkAt: t0 - 45000, failures: 0, hidden: true }, t0)).toEqual({ tone: 'ok', text: 'Live · synced 45 s ago' }); // hidden tabs poll every 60 s, so 45 s is not stale there
    expect(kit.syncLabel({ lastOkAt: t0 - 200000, failures: 0, hidden: true }, t0)).toEqual({ tone: 'stale', text: 'Stale — last synced 3 min ago' });
    expect(kit.syncLabel({ lastOkAt: t0 - 180000, failures: 1 }, t0)).toEqual({ tone: 'error', text: 'Sync error — last synced 3 min ago, retrying' });
  });
});

describe('the page is wired to it', () => {
  const app = fs.readFileSync(path.join(DASH, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(DASH, 'index.html'), 'utf8');
  const accounts = fs.readFileSync(path.join(DASH, 'pages-accounts.js'), 'utf8');
  it('app.js applies only newer snapshots, backs off on failure, refreshes on visibility, and the footer carries the status', () => {
    expect(app).toContain('UiKit.isNewerSnapshot(liveSync.lastSnapshotAt, data.generatedAt)');
    expect(app).toContain("UiKit.syncDelay({ hidden: document.hidden, failures: liveSync.failures })");
    expect(app).toMatch(/visibilitychange/);
    expect(app).toContain('liveSync.failures += 1');
    expect(app).not.toMatch(/accountsTimer/); // the old fixed 10 s timer (and its boot reference) is gone
    expect(app).toMatch(/liveSync\.timer = setTimeout\(pollAccounts/);
    expect(html).toMatch(/id="sync-status"[^>]*role="status"/);
    expect(accounts).toContain("document.addEventListener('workspace:accounts', onLive)");
  });
});
