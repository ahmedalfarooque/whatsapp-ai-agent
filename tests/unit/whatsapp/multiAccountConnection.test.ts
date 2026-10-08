import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

type Listener = (...args: unknown[]) => void;

const fixtures = vi.hoisted(() => ({
  sockets: [] as Array<{ ev: EventEmitter; user?: { id: string; name?: string }; sendMessage: ReturnType<typeof vi.fn>; logout: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }>,
  inbound: vi.fn(),
  claimed: vi.fn(() => true),
  accounts: [] as Array<{
    id: number; name: string; nameAr: string | null; businessCategory: string | null; connectionMethod: 'qr' | 'meta'; authDir: string; enabled: boolean;
    phoneNumber: string | null; jid: string | null; displayName: string | null; status: string; connectedAt: string | null; disconnectedAt: string | null;
    lastError: string | null; createdAt: string; updatedAt: string;
  }>,
  lidPn: null as string | null,
  lidMappings: [] as Array<[string, string]>,
  replyJids: [] as Array<[number, string]>,
  activity: vi.fn(),
  fsExists: vi.fn(() => false),
  rm: vi.fn(),
  rename: vi.fn(),
  ownerFile: null as string | null,
  operator: vi.fn(() => ({ text: 'done', result: { changed: true } })),
  outboxSender: null as null | ((jid: string, text: string) => Promise<string | null>),
  flush: vi.fn(async () => 0),
  written: [] as string[],
}));

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn((p: string) => (String(p).endsWith('baileys-auth.owner.json') ? fixtures.ownerFile !== null : fixtures.fsExists())),
    rmSync: fixtures.rm,
    renameSync: fixtures.rename,
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => fixtures.ownerFile ?? ''),
    writeFileSync: vi.fn((p: string, data: string) => { fixtures.written.push(data); if (String(p).endsWith('baileys-auth.owner.json')) fixtures.ownerFile = data; }),
    unlinkSync: vi.fn(() => { fixtures.ownerFile = null; }),
  },
}));
vi.mock('../../../src/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }, maskWaId: (v: string) => v }));
vi.mock('../../../src/config/env', () => ({ env: { DATABASE_PATH: './data/app.db', NODE_ENV: 'production' } }));
vi.mock('../../../src/config/businessSettings', () => ({ getBusinessSettings: () => ({ businessName: 'Rowad Alfa Auto Care' }) }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,test') } }));
vi.mock('../../../src/knowledge/loader', () => ({ loadKnowledgeBase: vi.fn(() => ({ sections: [], asPromptText: '' })) }));
vi.mock('../../../src/pipeline/processInboundMessage', () => ({ processInboundMessage: fixtures.inbound }));
vi.mock('../../../src/pipeline/idempotency', () => ({
  claimWebhookEvent: fixtures.claimed, markWebhookEventProcessed: vi.fn(), markWebhookEventFailed: vi.fn(),
}));
vi.mock('../../../src/memory/customerRepo', () => ({
  getCustomerByWaId: vi.fn(() => ({ id: 7 })),
  setCustomerReplyJid: vi.fn((id: number, jid: string) => { fixtures.replyJids.push([id, jid]); }),
}));
vi.mock('../../../src/memory/lidMapRepo', () => ({
  canonicalJid: (jid: string) => `${(jid.split('@')[0] ?? '').split(':')[0]}@${jid.split('@')[1] ?? ''}`,
  rememberLidMapping: vi.fn((lid: string, pn: string) => { fixtures.lidMappings.push([lid, pn]); }),
  getPnForLid: vi.fn(() => fixtures.lidPn),
}));
// Accounts live in SQLite; this suite mocks the filesystem (so no migrations
// can run) and therefore fakes the account repository in memory. Account 1 is
// the legacy business with the legacy 'baileys-auth' directory; account 2 is a
// second business with its own directory, used by the multi-account tests.
vi.mock('../../../src/accounts/accountRepo', () => {
  const accounts = fixtures.accounts;
  const get = (id: number) => accounts.find((a) => a.id === id);
  return {
    getAccount: vi.fn((id: number) => get(id)),
    listEnabledAccounts: vi.fn(() => accounts.filter((a) => a.enabled)),
    authDirFor: (a: { authDir: string }) => `/data/${a.authDir}`,
    dataDir: () => '/data',
    setAccountStatus: vi.fn((id: number, status: string, err: string | null) => { const a = get(id); if (a) { a.status = status; a.lastError = err; } }),
    recordAccountConnected: vi.fn((id: number, identity: { phoneNumber: string | null; jid: string; displayName: string | null }) => {
      const a = get(id); if (a) Object.assign(a, identity, { status: 'connected', connectedAt: 'now' });
    }),
    clearAccountIdentity: vi.fn((id: number) => { const a = get(id); if (a) Object.assign(a, { phoneNumber: null, jid: null, displayName: null, status: 'logged_out' }); }),
    findAccountHoldingIdentity: vi.fn((id: number, identity: { phoneNumber: string | null; jid: string }) => { const user = (j: string | null) => ((j ?? '').split('@')[0] ?? '').split(':')[0]; return accounts.find((a) => a.id !== id && ((identity.phoneNumber !== null && a.phoneNumber === identity.phoneNumber) || (a.jid !== null && user(a.jid) !== '' && user(a.jid) === user(identity.jid)))) ?? null; }),
  };
});
vi.mock('../../../src/automation/settingsRepo', () => ({ recordReplyActivity: fixtures.activity }));
vi.mock('../../../src/requests/requestService', () => ({
  parseOperatorCommand: (text: string | undefined) => {
    const m = (text ?? '').trim().match(/^(CONFIRM|REJECT)\s+((?:APT|INQ)-\d{4}-\d{4})$/i);
    return m ? { status: m[1]!.toLowerCase() === 'confirm' ? 'confirmed' : 'rejected', reference: m[2]!.toUpperCase() } : null;
  },
  handleOperatorCommand: fixtures.operator,
}));
vi.mock('../../../src/notifications/outbox', () => ({
  registerOutboxSender: vi.fn((fn: unknown) => { fixtures.outboxSender = fn as (jid: string, text: string) => Promise<string | null>; }),
  flushOutbox: fixtures.flush,
  NotConnectedError: class NotConnectedError extends Error {},
}));
vi.mock('@whiskeysockets/baileys', () => {
  const makeWASocket = vi.fn(() => {
    const ev = new EventEmitter();
    const socket = {
      ev: Object.assign(ev, { removeAllListeners: ev.removeAllListeners.bind(ev) }),
      user: undefined as { id: string; name?: string } | undefined,
      sendMessage: vi.fn().mockResolvedValue({ key: { id: 'sent-1' } }),
      logout: vi.fn().mockResolvedValue(undefined),
      end: vi.fn(),
    };
    fixtures.sockets.push(socket);
    return socket;
  });
  return {
    default: makeWASocket,
    makeWASocket,
    useMultiFileAuthState: vi.fn().mockResolvedValue({ state: { creds: { me: undefined } }, saveCreds: vi.fn() }),
    fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 1] }),
    DisconnectReason: { loggedOut: 401, timedOut: 408, connectionClosed: 428, restartRequired: 515 },
  };
});

function emit(socket: (typeof fixtures.sockets)[number], event: string, payload: unknown) {
  (socket.ev.listeners(event) as Listener[]).forEach((l) => l(payload));
}
const tick = () => new Promise((r) => setTimeout(r, 0));


// ---------------------------------------------------------------------------
// Multiple WhatsApp accounts: one independent Baileys connection per business.
// (Same mocks as qrConnection.test.ts — the preamble above is copied from it.)
// ---------------------------------------------------------------------------
describe('multi-account connection manager', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fixtures.sockets.length = 0;
    fixtures.ownerFile = null; fixtures.lidPn = null; fixtures.flush.mockClear(); fixtures.rm.mockClear(); fixtures.rename.mockClear(); fixtures.replyJids.length = 0;
    fixtures.accounts.length = 0;
    fixtures.accounts.push(
      { id: 1, name: 'Rowad Alfa Auto Care', nameAr: null, businessCategory: 'Car care', connectionMethod: 'qr', authDir: 'baileys-auth', enabled: true, phoneNumber: null, jid: null, displayName: null, status: 'idle', connectedAt: null, disconnectedAt: null, lastError: null, createdAt: 'now', updatedAt: 'now' },
      { id: 2, name: 'Noor Salon', nameAr: 'صالون نور', businessCategory: 'Salon', connectionMethod: 'qr', authDir: 'accounts/2/baileys-auth', enabled: true, phoneNumber: null, jid: null, displayName: null, status: 'idle', connectedAt: null, disconnectedAt: null, lastError: null, createdAt: 'now', updatedAt: 'now' },
      { id: 3, name: 'Paused Cafe', nameAr: null, businessCategory: 'Cafe', connectionMethod: 'qr', authDir: 'accounts/3/baileys-auth', enabled: false, phoneNumber: null, jid: null, displayName: null, status: 'idle', connectedAt: null, disconnectedAt: null, lastError: null, createdAt: 'now', updatedAt: 'now' },
    );
    delete process.env.VERCEL;
  });
  afterEach(async () => {
    vi.useRealTimers();
    const qr = await import('../../../src/whatsapp/qrConnection');
    await qr.closeQrConnection();
  });

  async function openBoth() {
    const qr = await import('../../../src/whatsapp/qrConnection');
    await Promise.all([qr.startQrConnection(1), qr.startQrConnection(2)]);
    expect(fixtures.sockets).toHaveLength(2);
    const s1 = fixtures.sockets[0]!;
    const s2 = fixtures.sockets[1]!;
    s1.user = { id: '966558190545:1@s.whatsapp.net', name: 'Rowad Alfa' };
    s2.user = { id: '966511111111:1@s.whatsapp.net', name: 'Noor Salon' };
    emit(s1, 'connection.update', { connection: 'open' });
    emit(s2, 'connection.update', { connection: 'open' });
    await tick();
    return { qr, s1, s2 };
  }

  it('opens one socket per account with its own auth directory, QR and identity; both connected at the same time', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    const baileys = await import('@whiskeysockets/baileys');
    await Promise.all([qr.startQrConnection(1), qr.startQrConnection(2), qr.startQrConnection(2)]);
    expect(fixtures.sockets).toHaveLength(2);
    const dirs = vi.mocked(baileys.useMultiFileAuthState).mock.calls.map((c) => String(c[0]).replace(/\\/g, '/'));
    expect(dirs).toEqual(expect.arrayContaining(['/data/baileys-auth', '/data/accounts/2/baileys-auth']));

    emit(fixtures.sockets[1]!, 'connection.update', { qr: 'salon-pairing' });
    await tick();
    expect(qr.getQrStatus(2).phase).toBe('scan');
    expect(qr.getQrStatus(2).qr).toMatch(/^data:image/);
    expect(qr.getQrStatus(1).phase).not.toBe('scan'); // account 1 untouched by account 2's QR

    const s1 = fixtures.sockets[0]!;
    const s2 = fixtures.sockets[1]!;
    s1.user = { id: '966558190545:1@s.whatsapp.net', name: 'Rowad Alfa' };
    s2.user = { id: '966511111111:1@s.whatsapp.net', name: 'Noor Salon' };
    emit(s1, 'connection.update', { connection: 'open' });
    emit(s2, 'connection.update', { connection: 'open' });
    await tick();
    expect(qr.getQrStatus(1)).toMatchObject({ accountId: 1, phase: 'connected', phoneNumber: '+966558190545', accountName: 'Rowad Alfa Auto Care' });
    expect(qr.getQrStatus(2)).toMatchObject({ accountId: 2, phase: 'connected', phoneNumber: '+966511111111', accountName: 'Noor Salon' });
    expect(qr.getQrStatus(1).diagnostics.totalActiveSockets).toBe(2);
    expect(qr.listConnections().map((c) => c.accountId).sort()).toEqual([1, 2]);
  });

  it('routes an inbound message to the account whose socket received it and replies through that same socket', async () => {
    const { s1, s2 } = await openBoth();
    const { replyTransport } = await import('../../../src/whatsapp/replyTransport');
    fixtures.inbound.mockImplementation(async () => { await replyTransport.getStore()!.text('ignored', 'reply'); });
    const msg = (id: string) => ({ key: { remoteJid: '966500000001@s.whatsapp.net', fromMe: false, id }, message: { conversation: 'Hi' }, messageTimestamp: Math.floor(Date.now() / 1000) });
    emit(s2, 'messages.upsert', { type: 'notify', messages: [msg('m-salon')] });
    emit(s1, 'messages.upsert', { type: 'notify', messages: [msg('m-cars')] });
    await tick(); await tick();
    expect(fixtures.inbound).toHaveBeenCalledTimes(2);
    const byAccount: Record<number, { messageId: string; channel: string }> = {};
    for (const c of fixtures.inbound.mock.calls) {
      const m = c[0] as { accountId: number; messageId: string; channel: string };
      byAccount[m.accountId] = m;
    }
    expect(byAccount[2]).toMatchObject({ messageId: 'qr:2:m-salon', channel: 'qr' });
    expect(byAccount[1]).toMatchObject({ messageId: 'qr:m-cars', channel: 'qr' }); // legacy id format preserved for account 1
    expect(s2.sendMessage).toHaveBeenCalledTimes(1);
    expect(s1.sendMessage).toHaveBeenCalledTimes(1);
    fixtures.inbound.mockReset();
  });

  it('outbox notifications leave through their own account; a disconnected account defers only its own rows', async () => {
    const { s1, s2 } = await openBoth();
    expect(await fixtures.outboxSender!('x@s.whatsapp.net', 'alert', 2)).toBe('sent-1');
    expect(s2.sendMessage).toHaveBeenCalledTimes(1);
    expect(s1.sendMessage).not.toHaveBeenCalled();
    emit(s2, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
    await expect(fixtures.outboxSender!('x@s.whatsapp.net', 'alert', 2)).rejects.toThrow(); // NotConnectedError for account 2 (the test mock's class drops the message)
    expect(await fixtures.outboxSender!('x@s.whatsapp.net', 'alert', 1)).toBe('sent-1'); // account 1 still delivers
    await expect(fixtures.outboxSender!('x@s.whatsapp.net', 'alert', 99)).rejects.toThrow();
  });

  it('a transient close on account A reconnects A only; account B keeps its socket and stays connected', async () => {
    const { qr, s1 } = await openBoth();
    vi.useFakeTimers(); // after the sockets are open: the reconnect timer is what we drive
    emit(s1, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
    expect(qr.getQrStatus(1).phase).toBe('reconnecting');
    expect(qr.getQrStatus(2).phase).toBe('connected');
    await vi.advanceTimersByTimeAsync(1500);
    expect(fixtures.sockets).toHaveLength(3); // exactly one new socket, for account 1
    expect(qr.getQrStatus(2).phase).toBe('connected');
    expect(qr.getQrStatus(2).diagnostics.socketGeneration).toBe(1);
  });

  it('logging out account A deletes only its credentials; account B session directory and connection are untouched', async () => {
    const { qr, s2 } = await openBoth();
    await qr.stopQrConnection(1);
    const removed = fixtures.rm.mock.calls.map((c) => String(c[0]).replace(/\\/g, '/'));
    expect(removed).toContain('/data/baileys-auth');
    expect(removed.some((p) => p.includes('accounts/2'))).toBe(false);
    expect(qr.getQrStatus(1).phase).toBe('logged_out');
    expect(qr.getQrStatus(2).phase).toBe('connected');
    expect(s2.end).not.toHaveBeenCalled();
    expect(fixtures.accounts[1]!.phoneNumber).toBe('+966511111111');
    expect(fixtures.accounts[0]!.phoneNumber).toBeNull();
  });

  it('a 401 (loggedOut) from WhatsApp archives only that account store and clears only its identity', async () => {
    const { qr, s2 } = await openBoth();
    emit(s2, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    await tick();
    expect(qr.getQrStatus(2).phase).toBe('logged_out');
    expect(qr.getQrStatus(2).lastError).toBe('logged_out_by_whatsapp_401');
    const renamed = fixtures.rename.mock.calls.map((c) => String(c[0]).replace(/\\/g, '/'));
    expect(renamed).toEqual(['/data/accounts/2/baileys-auth']);
    expect(qr.getQrStatus(1).phase).toBe('connected');
    expect(fixtures.accounts[0]!.phoneNumber).toBe('+966558190545');
  });

  it('a 515 (restart required) after pairing reconnects only that account', async () => {
    const { qr, s2 } = await openBoth();
    vi.useFakeTimers();
    emit(s2, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    expect(qr.getQrStatus(2).phase).toBe('connecting');
    expect(qr.getQrStatus(1).phase).toBe('connected');
    await vi.advanceTimersByTimeAsync(1200);
    expect(fixtures.sockets).toHaveLength(3);
    expect(qr.getQrStatus(1).diagnostics.socketGeneration).toBe(1);
    expect(qr.getQrStatus(2).diagnostics.socketGeneration).toBe(2);
  });

  it('Refresh QR on account B replaces only the B pairing socket', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    await Promise.all([qr.startQrConnection(1), qr.startQrConnection(2)]);
    emit(fixtures.sockets[1]!, 'connection.update', { qr: 'first' });
    await tick();
    const result = await qr.refreshQrConnection(2);
    expect(result.notice).toBe('refreshed');
    expect(fixtures.sockets).toHaveLength(3);
    expect(fixtures.sockets[0]!.end).not.toHaveBeenCalled();
    expect(fixtures.sockets[1]!.end).toHaveBeenCalled();
    expect(fixtures.rm).not.toHaveBeenCalled();
  });

  it('boot resumes every ENABLED account independently (a disabled account is skipped) and a disabled account refuses to start', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    qr.resumeQrConnection();
    await tick(); await tick();
    expect(fixtures.sockets).toHaveLength(2);
    const baileys = await import('@whiskeysockets/baileys');
    const dirs = vi.mocked(baileys.useMultiFileAuthState).mock.calls.map((c) => String(c[0]).replace(/\\/g, '/'));
    expect(dirs.some((d) => d.includes('accounts/3'))).toBe(false);
    await expect(qr.startQrConnection(3)).rejects.toThrow(/disabled/);
    await expect(qr.startQrConnection(42)).rejects.toThrow(/does not exist/);
  });

  it('disabling an account closes its socket but keeps its credentials; shutdown closes every account', async () => {
    const { qr, s1, s2 } = await openBoth();
    await qr.suspendQrConnection(2);
    expect(s2.end).toHaveBeenCalled();
    expect(fixtures.rm).not.toHaveBeenCalled();
    expect(qr.getQrStatus(2).phase).toBe('disconnected');
    expect(qr.getQrStatus(1).phase).toBe('connected');
    await qr.closeQrConnection();
    expect(s1.end).toHaveBeenCalled();
    expect(fixtures.rm).not.toHaveBeenCalled();
  });
});
