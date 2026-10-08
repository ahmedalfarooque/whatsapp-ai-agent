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

describe('Baileys QR connection lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fixtures.sockets.length = 0;
    fixtures.ownerFile = null; fixtures.lidPn = null; fixtures.operator.mockClear(); fixtures.flush.mockClear(); fixtures.lidMappings.length = 0; fixtures.replyJids.length = 0; fixtures.written.length = 0;
    fixtures.accounts.length = 0;
    fixtures.accounts.push(
      { id: 1, name: 'Rowad Alfa Auto Care', nameAr: null, businessCategory: 'Car care', connectionMethod: 'qr', authDir: 'baileys-auth', enabled: true, phoneNumber: null, jid: null, displayName: null, status: 'idle', connectedAt: null, disconnectedAt: null, lastError: null, createdAt: 'now', updatedAt: 'now' },
      { id: 2, name: 'Noor Salon', nameAr: 'صالون نور', businessCategory: 'Salon', connectionMethod: 'qr', authDir: 'accounts/2/baileys-auth', enabled: true, phoneNumber: null, jid: null, displayName: null, status: 'idle', connectedAt: null, disconnectedAt: null, lastError: null, createdAt: 'now', updatedAt: 'now' },
    );
    delete process.env.VERCEL;
  });
  afterEach(async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    await qr.closeQrConnection();
  });

  it('opens one socket for concurrent starts, renders the QR, then records the scanned number on open', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    await Promise.all([qr.startQrConnection(), qr.startQrConnection()]);
    expect(fixtures.sockets).toHaveLength(1);
    const socket = fixtures.sockets[0]!;

    emit(socket, 'connection.update', { qr: 'pairing-payload' });
    await tick();
    expect(qr.getQrStatus().phase).toBe('scan');
    expect(qr.getQrStatus().qr).toMatch(/^data:image\/png/);

    socket.user = { id: '966558190545:12@s.whatsapp.net', name: 'Rowad Alfa' };
    emit(socket, 'connection.update', { connection: 'open' });
    await tick();
    const status = qr.getQrStatus();
    expect(status.phase).toBe('connected');
    expect(status.qr).toBeNull();
    expect(status.phoneNumber).toBe('+966558190545');
    expect(status.displayName).toBe('Rowad Alfa');
  });

  it('routes new direct text into the pipeline once, maps numeric replies to menu IDs, and ignores groups/self/broadcast', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    await qr.startQrConnection();
    const socket = fixtures.sockets[0]!;
    socket.user = { id: '966558190545@s.whatsapp.net' };
    emit(socket, 'connection.update', { connection: 'open' });

    const base = { key: { remoteJid: '966500000001@s.whatsapp.net', fromMe: false, id: 'm1' }, message: { conversation: 'Hello' }, pushName: 'Ali', messageTimestamp: Math.floor(Date.now() / 1000) };
    emit(socket, 'messages.upsert', { type: 'notify', messages: [
      { ...base, key: { ...base.key, remoteJid: '1203@g.us' } },
      { ...base, key: { ...base.key, fromMe: true } },
      { ...base, key: { ...base.key, remoteJid: 'status@broadcast' } },
    ] });
    await tick();
    expect(fixtures.inbound).not.toHaveBeenCalled();

    emit(socket, 'messages.upsert', { type: 'notify', messages: [base] });
    await tick();
    expect(fixtures.inbound).toHaveBeenCalledTimes(1);
    expect(fixtures.inbound.mock.calls[0]?.[0]).toMatchObject({
      waId: '966500000001@s.whatsapp.net', messageId: 'qr:m1', text: 'Hello', type: 'text', contactName: 'Ali', channel: 'qr',
    });

    fixtures.claimed.mockReturnValueOnce(false);
    emit(socket, 'messages.upsert', { type: 'notify', messages: [base] });
    await tick();
    expect(fixtures.inbound).toHaveBeenCalledTimes(1);

    // Numbers are plain text for the pipeline: the guided-menu router maps them by the customer's menu state.
    emit(socket, 'messages.upsert', { type: 'notify', messages: [{ ...base, key: { ...base.key, id: 'm2' }, message: { conversation: '٢' } }] });
    await tick();
    expect(fixtures.inbound.mock.calls[1]?.[0]).toMatchObject({ type: 'text', text: '٢' });

    // Offline backlog delivered after a reconnect is never auto-answered.
    emit(socket, 'messages.upsert', { type: 'notify', messages: [{ ...base, key: { ...base.key, id: 'old1' }, messageTimestamp: Math.floor(Date.now() / 1000) - 3600 }] });
    await tick();
    expect(fixtures.inbound).toHaveBeenCalledTimes(2);
    expect(fixtures.activity).toHaveBeenCalledWith(expect.objectContaining({ kind: 'suppressed' }));
  });

  it('sends replies through the same socket and flattens interactive menus to numbered text', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    const { replyTransport } = await import('../../../src/whatsapp/replyTransport');
    fixtures.inbound.mockImplementationOnce(async () => {
      const t = replyTransport.getStore()!;
      await t.text('ignored', 'Hi there');
      await t.interactive('ignored', { kind: 'buttons', body: 'Pick', buttons: [{ id: 'lang_en', title: 'English' }, { id: 'lang_ar', title: 'العربية' }] });
    });
    await qr.startQrConnection();
    const socket = fixtures.sockets[0]!;
    socket.user = { id: '966558190545@s.whatsapp.net' };
    emit(socket, 'connection.update', { connection: 'open' });
    emit(socket, 'messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '966500000002@s.whatsapp.net', fromMe: false, id: 'x1' }, message: { conversation: 'hi' } }] });
    await tick(); await tick();
    expect(socket.sendMessage).toHaveBeenCalledTimes(2);
    expect(socket.sendMessage.mock.calls[0]?.[0]).toBe('966500000002@s.whatsapp.net');
    expect(socket.sendMessage.mock.calls[1]?.[1]).toMatchObject({ text: expect.stringContaining('1. English') });
    expect(fixtures.replyJids).toContainEqual([7, '966500000002@s.whatsapp.net']);
  });

  it('sends a catalogue PDF as a real WhatsApp document through the same socket, to the address the customer wrote from', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    const { replyTransport } = await import('../../../src/whatsapp/replyTransport');
    const bytes = Buffer.from('%PDF-1.4 catalogue bytes');
    fixtures.inbound.mockImplementationOnce(async () => {
      await replyTransport.getStore()!.document!('ignored', { fileName: 'Jotun Soulful Spaces.pdf', mimeType: 'application/pdf', bytes, caption: '📚 Jotun Soulful Spaces' });
    });
    await qr.startQrConnection();
    const socket = fixtures.sockets[0]!;
    socket.user = { id: '966558190545@s.whatsapp.net' };
    emit(socket, 'connection.update', { connection: 'open' });
    emit(socket, 'messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '966500000002@s.whatsapp.net', fromMe: false, id: 'doc1' }, message: { conversation: 'catalogue' } }] });
    await tick(); await tick();
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    expect(socket.sendMessage.mock.calls[0]?.[0]).toBe('966500000002@s.whatsapp.net');
    expect(socket.sendMessage.mock.calls[0]?.[1]).toEqual({ document: bytes, mimetype: 'application/pdf', fileName: 'Jotun Soulful Spaces.pdf', caption: '📚 Jotun Soulful Spaces' });
  });

  it('a failed document send is reported to the caller (the pipeline then apologises) and is not swallowed', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    const { replyTransport } = await import('../../../src/whatsapp/replyTransport');
    let outcome: unknown = 'not run';
    fixtures.inbound.mockImplementationOnce(async () => {
      outcome = await replyTransport.getStore()!.document!('ignored', { fileName: 'x.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-') }).catch((e: Error) => e.message);
    });
    await qr.startQrConnection();
    const socket = fixtures.sockets[0]!;
    socket.user = { id: '966558190545@s.whatsapp.net' };
    emit(socket, 'connection.update', { connection: 'open' });
    socket.sendMessage.mockRejectedValueOnce(new Error('upload failed'));
    emit(socket, 'messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '966500000002@s.whatsapp.net', fromMe: false, id: 'doc2' }, message: { conversation: 'catalogue' } }] });
    await tick(); await tick();
    expect(outcome).toBe('upload failed');
  });

  it('LID chat with senderPn: identifies the customer by phone, replies to the LID address it arrived on, stores the pairing', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    const { replyTransport } = await import('../../../src/whatsapp/replyTransport');
    fixtures.inbound.mockImplementationOnce(async () => { await replyTransport.getStore()!.text('ignored', 'reply'); });
    await qr.startQrConnection();
    const socket = fixtures.sockets[0]!;
    socket.user = { id: '966558190545@s.whatsapp.net' };
    emit(socket, 'connection.update', { connection: 'open' });
    emit(socket, 'messages.upsert', { type: 'notify', messages: [{
      key: { remoteJid: '237374906863661@lid', senderPn: '966500000009:3@s.whatsapp.net', fromMe: false, id: 'lid1' },
      message: { conversation: 'Hello' }, pushName: 'Lid User',
    }] });
    await tick(); await tick();
    expect(fixtures.inbound.mock.calls[0]?.[0]).toMatchObject({ waId: '966500000009@s.whatsapp.net', text: 'Hello' });
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    // Never translate the reply address: a phone-JID send would fork the Signal session (Bad MAC on the next inbound).
    expect(socket.sendMessage.mock.calls[0]?.[0]).toBe('237374906863661@lid');
    expect(fixtures.lidMappings).toContainEqual(['237374906863661@lid', '966500000009@s.whatsapp.net']);
    expect(fixtures.replyJids).toContainEqual([7, '237374906863661@lid']);
  });

  it('LID chat without senderPn (retry / offline delivery): resolves the same customer through the stored pairing', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    const { replyTransport } = await import('../../../src/whatsapp/replyTransport');
    fixtures.lidPn = '966500000009@s.whatsapp.net';
    fixtures.inbound.mockImplementationOnce(async () => { await replyTransport.getStore()!.text('ignored', 'reply'); });
    await qr.startQrConnection();
    const socket = fixtures.sockets[0]!;
    socket.user = { id: '966558190545@s.whatsapp.net' };
    emit(socket, 'connection.update', { connection: 'open' });
    emit(socket, 'messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '237374906863661@lid', fromMe: false, id: 'lid2' }, message: { conversation: '1' } }] });
    await tick(); await tick();
    expect(fixtures.inbound.mock.calls[0]?.[0]).toMatchObject({ waId: '966500000009@s.whatsapp.net', text: '1' });
    expect(socket.sendMessage.mock.calls[0]?.[0]).toBe('237374906863661@lid');
  });

  it('LID chat with no known phone: the LID itself identifies the customer (never dropped)', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    const { replyTransport } = await import('../../../src/whatsapp/replyTransport');
    fixtures.lidPn = null;
    fixtures.inbound.mockImplementationOnce(async () => { await replyTransport.getStore()!.text('ignored', 'reply'); });
    await qr.startQrConnection();
    const socket = fixtures.sockets[0]!;
    socket.user = { id: '966558190545@s.whatsapp.net' };
    emit(socket, 'connection.update', { connection: 'open' });
    emit(socket, 'messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '237374906863661@lid', fromMe: false, id: 'lid3' }, message: { conversation: 'Hi' } }] });
    await tick(); await tick();
    expect(fixtures.inbound.mock.calls[0]?.[0]).toMatchObject({ waId: '237374906863661@lid' });
    expect(socket.sendMessage.mock.calls[0]?.[0]).toBe('237374906863661@lid');
  });

  it('consecutive LID messages (with and without senderPn) stay one customer, one reply each, all to the LID address; exact duplicate events are processed once', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    const { replyTransport } = await import('../../../src/whatsapp/replyTransport');
    fixtures.inbound.mockImplementation(async () => { await replyTransport.getStore()!.text('ignored', 'reply'); });
    await qr.startQrConnection();
    const socket = fixtures.sockets[0]!;
    socket.user = { id: '966558190545@s.whatsapp.net' };
    emit(socket, 'connection.update', { connection: 'open' });
    const lid = '237374906863661@lid';
    const msgs = [
      { key: { remoteJid: lid, senderPn: '966500000009@s.whatsapp.net', fromMe: false, id: 'c1' }, message: { conversation: 'Hi' } },
      { key: { remoteJid: lid, fromMe: false, id: 'c2' }, message: { conversation: '2' } }, // retry-style: no senderPn
      { key: { remoteJid: lid, senderPn: '966500000009@s.whatsapp.net', fromMe: false, id: 'c3' }, message: { conversation: '1' } },
    ];
    fixtures.lidPn = null;
    for (const m of msgs) {
      // after c1 the mapping exists → mock the repo lookup the same way the real table would answer
      if (m.key.id !== 'c1') fixtures.lidPn = '966500000009@s.whatsapp.net';
      emit(socket, 'messages.upsert', { type: 'notify', messages: [m] });
      await tick(); await tick();
    }
    // Baileys re-emits the same message (e.g. after a retry receipt) → claimWebhookEvent says "seen"
    fixtures.claimed.mockReturnValueOnce(false);
    emit(socket, 'messages.upsert', { type: 'notify', messages: [msgs[2]!] });
    await tick(); await tick();
    expect(fixtures.inbound).toHaveBeenCalledTimes(3);
    expect(fixtures.inbound.mock.calls.map((c) => (c[0] as { waId: string }).waId)).toEqual(Array(3).fill('966500000009@s.whatsapp.net'));
    expect(socket.sendMessage).toHaveBeenCalledTimes(3);
    for (const call of socket.sendMessage.mock.calls) expect(call[0]).toBe(lid);
    // "append" (history sync) batches are never processed as live traffic
    emit(socket, 'messages.upsert', { type: 'append', messages: [{ key: { remoteJid: lid, fromMe: false, id: 'h1' }, message: { conversation: 'old' } }] });
    await tick();
    expect(fixtures.inbound).toHaveBeenCalledTimes(3);
    fixtures.inbound.mockReset();
  });

  it('after a reconnect only the new socket generation delivers messages; the old socket cannot send or process', async () => {
    vi.useFakeTimers();
    try {
      const qr = await import('../../../src/whatsapp/qrConnection');
      const { replyTransport } = await import('../../../src/whatsapp/replyTransport');
      fixtures.inbound.mockImplementation(async () => { await replyTransport.getStore()!.text('ignored', 'reply'); });
      await qr.startQrConnection();
      const first = fixtures.sockets[0]!;
      first.user = { id: '966558190545@s.whatsapp.net' };
      emit(first, 'connection.update', { connection: 'open' });
      emit(first, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
      await vi.advanceTimersByTimeAsync(1500);
      const second = fixtures.sockets[1]!;
      second.user = { id: '966558190545@s.whatsapp.net' };
      emit(second, 'connection.update', { connection: 'open' });
      const msg = (id: string) => ({ key: { remoteJid: '966500000009@s.whatsapp.net', fromMe: false, id }, message: { conversation: 'hello' }, messageTimestamp: Math.floor(Date.now() / 1000) });
      emit(first, 'messages.upsert', { type: 'notify', messages: [msg('old-gen')] }); // stale listener → ignored by generation guard
      emit(second, 'messages.upsert', { type: 'notify', messages: [msg('new-gen')] });
      await vi.advanceTimersByTimeAsync(10);
      expect(fixtures.inbound).toHaveBeenCalledTimes(1);
      expect((fixtures.inbound.mock.calls[0]![0] as { messageId: string }).messageId).toBe('qr:new-gen');
      expect(first.sendMessage).not.toHaveBeenCalled();
      expect(second.sendMessage).toHaveBeenCalledTimes(1);
      expect(qr.getQrStatus().diagnostics.activeSockets).toBe(1);
      fixtures.inbound.mockReset();
    } finally {
      vi.useRealTimers();
    }
  });

  it('operator commands are accepted ONLY from the business account (key.fromMe); the same text from a customer is ordinary input', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    await qr.startQrConnection();
    const socket = fixtures.sockets[0]!;
    socket.user = { id: '966558190545@s.whatsapp.net' };
    emit(socket, 'connection.update', { connection: 'open' });
    expect(fixtures.flush).toHaveBeenCalled(); // pending notifications are flushed as soon as the session is up
    // customer types the command → normal pipeline, never an operator action
    emit(socket, 'messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '966500000009@s.whatsapp.net', fromMe: false, id: 'cust1' }, message: { conversation: 'CONFIRM APT-2026-3777' } }] });
    await tick(); await tick();
    expect(fixtures.operator).not.toHaveBeenCalled();
    expect(fixtures.inbound).toHaveBeenCalledTimes(1);
    // business account (own chat, fromMe) → operator command, answered in the same chat
    emit(socket, 'messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '966558190545@s.whatsapp.net', fromMe: true, id: 'op1' }, message: { conversation: 'CONFIRM APT-2026-3777' } }] });
    await tick(); await tick();
    expect(fixtures.operator).toHaveBeenCalledWith({ status: 'confirmed', reference: 'APT-2026-3777' }, expect.stringContaining('whatsapp:'), undefined, 1);
    expect(socket.sendMessage).toHaveBeenCalledWith('966558190545@s.whatsapp.net', { text: 'done' });
    // duplicate delivery of the same command event → ignored
    fixtures.claimed.mockReturnValueOnce(false);
    emit(socket, 'messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '966558190545@s.whatsapp.net', fromMe: true, id: 'op1' }, message: { conversation: 'CONFIRM APT-2026-3777' } }] });
    await tick(); await tick();
    expect(fixtures.operator).toHaveBeenCalledTimes(1);
    // our own outbound (fromMe, id we sent) is never re-read as a command
    const sentId = socket.sendMessage.mock.results[0]?.value ? 'sent-1' : 'sent-1';
    emit(socket, 'messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '966558190545@s.whatsapp.net', fromMe: true, id: sentId }, message: { conversation: 'REJECT APT-2026-3777' } }] });
    await tick(); await tick();
    expect(fixtures.operator).toHaveBeenCalledTimes(1);
    // the outbox sender uses the live socket and refuses when not connected
    expect(fixtures.outboxSender).toBeTypeOf('function');
    expect(await fixtures.outboxSender!('966558190545@s.whatsapp.net', 'alert', 1)).toBe('sent-1');
    emit(socket, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
    await expect(fixtures.outboxSender!('966558190545@s.whatsapp.net', 'alert', 1)).rejects.toThrow();
    fixtures.inbound.mockReset();
  });

  it('learns LID↔phone pairings from contact sync events', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    await qr.startQrConnection();
    const socket = fixtures.sockets[0]!;
    emit(socket, 'contacts.upsert', [{ id: '966500000011@s.whatsapp.net', lid: '111222333444555@lid' }, { id: '1203@g.us' }]);
    expect(fixtures.lidMappings).toContainEqual(['111222333444555@lid', '966500000011@s.whatsapp.net']);
  });

  it('reconnects after a transient close, and clears identity on logout', async () => {
    vi.useFakeTimers();
    try {
      const qr = await import('../../../src/whatsapp/qrConnection');
      await qr.startQrConnection();
      const first = fixtures.sockets[0]!;
      emit(first, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
      expect(qr.getQrStatus().phase).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(1500);
      expect(fixtures.sockets).toHaveLength(2);

      const second = fixtures.sockets[1]!;
      second.user = { id: '966558190545@s.whatsapp.net' };
      emit(second, 'connection.update', { connection: 'open' });
      expect(qr.getQrStatus().phoneNumber).toBe('+966558190545');
      emit(second, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
      expect(qr.getQrStatus().phase).toBe('logged_out');
      expect(qr.getQrStatus().phoneNumber).toBeNull();
      expect(qr.getQrStatus().lastError).toBe('logged_out_by_whatsapp_401');
      // 401 archives the (now invalid) credentials instead of deleting them; nothing is copied anywhere.
      expect(fixtures.rename).toHaveBeenCalledTimes(1);
      expect(String(fixtures.rename.mock.calls[0]![0])).toMatch(/baileys-auth$/);
      expect(String(fixtures.rename.mock.calls[0]![1])).toMatch(/baileys-auth\.loggedout-/);
      expect(fixtures.rm).not.toHaveBeenCalled();
      // no reconnect is scheduled after a 401 — a new scan is required
      await vi.advanceTimersByTimeAsync(70_000);
      expect(fixtures.sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reuses the cached WhatsApp Web version on reconnect and when the lookup times out (no 5 s stall per reconnect)', async () => {
    vi.useFakeTimers();
    try {
      const baileys = await import('@whiskeysockets/baileys');
      const fetchVersion = vi.mocked(baileys.fetchLatestBaileysVersion);
      const make = vi.mocked(baileys.makeWASocket);
      const qr = await import('../../../src/whatsapp/qrConnection');
      await qr.startQrConnection();
      expect(fetchVersion).toHaveBeenCalledTimes(1);
      expect(make.mock.calls[0]![0]!.version).toEqual([2, 3000, 1]);
      expect(qr.getQrStatus().diagnostics.versionSource).toBe('fetched');
      expect(fixtures.written.some((w) => w.includes('"version":[2,3000,1]'))).toBe(true);

      const first = fixtures.sockets[0]!;
      emit(first, 'connection.update', { connection: 'open' });
      emit(first, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
      await vi.advanceTimersByTimeAsync(1500);
      expect(fixtures.sockets).toHaveLength(2);
      expect(fetchVersion).toHaveBeenCalledTimes(1); // reconnect skipped the lookup
      expect(make.mock.calls[1]![0]!.version).toEqual([2, 3000, 1]);
      expect(qr.getQrStatus().diagnostics.versionSource).toBe('cached');

      const second = fixtures.sockets[1]!;
      emit(second, 'connection.update', { connection: 'open' });
      emit(second, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
      expect(qr.getQrStatus().phase).toBe('reconnecting');
      // Manual Retry resets the backoff → lookup is attempted again; when it hangs, the cached version is used after the 5 s cap.
      fetchVersion.mockImplementationOnce(() => new Promise(() => undefined));
      const retry = qr.retryQrConnection();
      await vi.advanceTimersByTimeAsync(5100);
      expect(await retry).toEqual({ notice: 'retrying' });
      expect(fetchVersion).toHaveBeenCalledTimes(2);
      expect(fixtures.sockets).toHaveLength(3);
      expect(make.mock.calls[2]![0]!.version).toEqual([2, 3000, 1]);
      expect(qr.getQrStatus().diagnostics.versionSource).toBe('cached');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flags an unstable network after three drops in ten minutes, with exactly one reconnect per drop and no storm', async () => {
    vi.useFakeTimers();
    fixtures.fsExists.mockImplementation(() => true); // saved session present: 408 (keep-alive lost) must reconnect, not expire a QR
    try {
      const qr = await import('../../../src/whatsapp/qrConnection');
      await qr.startQrConnection();
      for (let i = 0; i < 3; i += 1) {
        const socket = fixtures.sockets[fixtures.sockets.length - 1]!;
        socket.user = { id: '966558190545@s.whatsapp.net' };
        emit(socket, 'connection.update', { connection: 'open' });
        expect(qr.getQrStatus().diagnostics.connectedSince).not.toBeNull();
        await vi.advanceTimersByTimeAsync(90_000);
        emit(socket, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: i % 2 ? 408 : 428 } } } });
        expect(qr.getQrStatus().phase).toBe('reconnecting');
        expect(qr.getQrStatus().diagnostics.connectedSince).toBeNull();
        if (i === 2) expect(qr.getQrStatus().detail).toMatch(/unstable/); // third drop: the page stops calling it routine
        else expect(qr.getQrStatus().detail).not.toMatch(/unstable/);
        await vi.advanceTimersByTimeAsync(1500);
        expect(fixtures.sockets).toHaveLength(i + 2); // one new socket per drop
      }
      const status = qr.getQrStatus();
      expect(status.diagnostics.dropsLast10Min).toBe(3);
      expect(status.diagnostics.networkUnstable).toBe(true);
      expect(status.diagnostics.lastCloseAt).not.toBeNull();
      expect(status.phoneNumber).toBe('+966558190545'); // identity and credentials untouched by drops
      expect(fixtures.rename).not.toHaveBeenCalled();
      expect(fixtures.rm).not.toHaveBeenCalled();
      // a quiet stretch clears the flag
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(qr.getQrStatus().diagnostics.dropsLast10Min).toBe(0);
      expect(qr.getQrStatus().diagnostics.networkUnstable).toBe(false);
    } finally {
      fixtures.fsExists.mockImplementation(() => false);
      vi.useRealTimers();
    }
  });

  it('Refresh QR never disturbs a connected session; Retry only acts when disconnected; 515 after a scan is "pairing", not an error', async () => {
    vi.useFakeTimers();
    try {
      const qr = await import('../../../src/whatsapp/qrConnection');
      await qr.startQrConnection();
      const socket = fixtures.sockets[0]!;
      // pairing: QR shown, phone scans → isNewLogin, then WhatsApp closes with 515 restartRequired
      emit(socket, 'connection.update', { qr: 'qr-payload' });
      await vi.advanceTimersByTimeAsync(0);
      expect(qr.getQrStatus().phase).toBe('scan');
      expect(qr.getQrStatus().qrGeneratedAt).not.toBeNull();
      emit(socket, 'connection.update', { isNewLogin: true });
      expect(qr.getQrStatus().phase).toBe('connecting');
      emit(socket, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
      expect(qr.getQrStatus().phase).toBe('connecting');
      expect(qr.getQrStatus().diagnostics.lastDisconnectCode).toBe(515);
      await vi.advanceTimersByTimeAsync(1500);
      expect(fixtures.sockets).toHaveLength(2);
      const second = fixtures.sockets[1]!;
      second.user = { id: '966501112222@s.whatsapp.net', name: 'Other Shop' };
      emit(second, 'connection.update', { connection: 'open' });
      expect(qr.getQrStatus().phase).toBe('connected');
      expect(qr.getQrStatus().phoneNumber).toBe('+966501112222'); // dynamic: whoever scanned
      expect(qr.getQrStatus().displayName).toBe('Other Shop');
      // refresh while connected: no logout, no new socket
      expect(await qr.refreshQrConnection()).toEqual({ notice: 'already_connected' });
      expect(fixtures.sockets).toHaveLength(2);
      expect(second.logout).not.toHaveBeenCalled();
      expect(await qr.retryQrConnection()).toEqual({ notice: 'not_needed' });
      // drop → reconnecting → Retry opens exactly one new socket
      emit(second, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } });
      expect(qr.getQrStatus().phase).toBe('reconnecting');
      expect(await qr.retryQrConnection()).toEqual({ notice: 'retrying' });
      expect(fixtures.sockets).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(5000);
      expect(fixtures.sockets).toHaveLength(3); // the pending auto-reconnect was cancelled, not doubled
      const d = qr.getQrStatus().diagnostics;
      expect(d.pid).toBe(process.pid);
      expect(d.activeSockets).toBe(1);
      expect(d.socketGeneration).toBeGreaterThanOrEqual(3);
      expect(d.lastConnectionEvent?.type).toBe('socket_created');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Refresh QR while waiting for a scan replaces the pairing socket with exactly one new one (credentials untouched)', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    await qr.startQrConnection();
    emit(fixtures.sockets[0]!, 'connection.update', { qr: 'first' });
    await tick();
    expect(await qr.refreshQrConnection()).toEqual({ notice: 'refreshed' });
    expect(fixtures.sockets).toHaveLength(2);
    expect(fixtures.rm).not.toHaveBeenCalled();
    expect(fixtures.sockets[0]!.logout).not.toHaveBeenCalled();
  });

  it('refuses to open a second socket while another LIVE process owns the auth store; takes over a stale marker', async () => {
    const qr = await import('../../../src/whatsapp/qrConnection');
    fixtures.ownerFile = JSON.stringify({ pid: process.ppid, startedAt: 'x' }); // parent process is alive
    await qr.startQrConnection();
    expect(fixtures.sockets).toHaveLength(0);
    expect(qr.getQrStatus().phase).toBe('error');
    expect(qr.getQrStatus().lastError).toBe('auth_store_owned');

    fixtures.ownerFile = JSON.stringify({ pid: 999999, startedAt: 'x' }); // dead pid → stale marker
    await qr.startQrConnection();
    expect(fixtures.sockets).toHaveLength(1);
    expect(JSON.parse(fixtures.ownerFile!).pid).toBe(process.pid);
    await qr.closeQrConnection();
    expect(fixtures.ownerFile).toBeNull();
  });

  it('refuses to start in serverless hosting', async () => {
    process.env.VERCEL = '1';
    const qr = await import('../../../src/whatsapp/qrConnection');
    await expect(qr.startQrConnection()).rejects.toThrow('persistent');
    expect(fixtures.sockets).toHaveLength(0);
    delete process.env.VERCEL;
  });

  describe('binding the scanned identity to the right account', () => {
    const open = async (qr: typeof import('../../../src/whatsapp/qrConnection'), accountId: number, user?: { id: string; name?: string }) => {
      await qr.startQrConnection(accountId);
      const socket = fixtures.sockets[fixtures.sockets.length - 1]!;
      socket.user = user;
      emit(socket, 'connection.update', { connection: 'open' });
      await tick();
      return socket;
    };

    it('stores the scanned number on the account whose QR was scanned and leaves the other account alone', async () => {
      const qr = await import('../../../src/whatsapp/qrConnection');
      await open(qr, 1, { id: '966558190545:3@s.whatsapp.net', name: 'Rowad Alfa' });
      await open(qr, 2, { id: '966511223344:9@s.whatsapp.net', name: 'JOTUN' });
      expect(qr.getQrStatus(2)).toMatchObject({ phase: 'connected', phoneNumber: '+966511223344', displayName: 'JOTUN' });
      expect(fixtures.accounts[1]).toMatchObject({ jid: '966511223344:9@s.whatsapp.net' });
      expect(qr.getQrStatus(1)).toMatchObject({ phase: 'connected', phoneNumber: '+966558190545' });
      expect(fixtures.accounts[0]).toMatchObject({ jid: '966558190545:3@s.whatsapp.net' });
    });

    it('refuses a number that another account already holds: unlinks only the new device, archives only the new account auth folder, keeps the other account connected, and never reconnects', async () => {
      const qr = await import('../../../src/whatsapp/qrConnection');
      const first = await open(qr, 1, { id: '966558190545:3@s.whatsapp.net' });
      const second = await open(qr, 2, { id: '966558190545:21@s.whatsapp.net' });

      expect(second.logout).toHaveBeenCalledTimes(1);
      expect(first.logout).not.toHaveBeenCalled();
      expect(first.end).not.toHaveBeenCalled();
      const status = qr.getQrStatus(2);
      expect(status.phase).toBe('error');
      expect(status.phoneNumber).toBeNull();
      expect(status.detail).toContain('already connected');
      expect(status.detail).toContain('Rowad Alfa Auto Care');
      expect(fixtures.accounts[1]!.lastError).toBe('duplicate_number');
      expect(fixtures.accounts[1]!.jid).toBeNull();
      expect(fixtures.rename).toHaveBeenCalledTimes(1);
      expect(String(fixtures.rename.mock.calls[0]?.[0])).toBe('/data/accounts/2/baileys-auth');
      expect(fixtures.rm).not.toHaveBeenCalledWith('/data/baileys-auth', expect.anything());
      expect(qr.getQrStatus(1)).toMatchObject({ phase: 'connected', phoneNumber: '+966558190545' });
      expect(fixtures.accounts[0]).toMatchObject({ status: 'connected', jid: '966558190545:3@s.whatsapp.net' });

      // Late events from the rejected socket are ignored: no AI, no reconnect, still an error.
      emit(second, 'connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
      emit(second, 'messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '966500000001@s.whatsapp.net', fromMe: false, id: 'dup1' }, message: { conversation: 'hi' } }] });
      await tick();
      expect(fixtures.inbound).not.toHaveBeenCalled();
      expect(qr.getQrStatus(2).phase).toBe('error');
      expect(fixtures.sockets).toHaveLength(2);
    });

    it('does not tear down an already-bound session when it reconnects with its recorded number', async () => {
      Object.assign(fixtures.accounts[0]!, { phoneNumber: '+966511111111', jid: '966511111111:1@s.whatsapp.net' });
      Object.assign(fixtures.accounts[1]!, { phoneNumber: '+966511111111', jid: '966511111111:2@s.whatsapp.net' });
      const qr = await import('../../../src/whatsapp/qrConnection');
      const socket = await open(qr, 2, { id: '966511111111:2@s.whatsapp.net' });
      expect(socket.logout).not.toHaveBeenCalled();
      expect(fixtures.rename).not.toHaveBeenCalled();
      expect(qr.getQrStatus(2).phase).toBe('connected');
    });

    it('does not report connected, and does not start the AI, when WhatsApp opens without an identity', async () => {
      const qr = await import('../../../src/whatsapp/qrConnection');
      const socket = await open(qr, 2, undefined);
      const status = qr.getQrStatus(2);
      expect(status.phase).not.toBe('connected');
      expect(status.phoneNumber).toBeNull();
      expect(fixtures.accounts[1]!.status).not.toBe('connected');
      expect(fixtures.flush).not.toHaveBeenCalled();
      emit(socket, 'messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: '966500000001@s.whatsapp.net', fromMe: false, id: 'early1' }, message: { conversation: 'hi' } }] });
      await tick();
      expect(fixtures.inbound).not.toHaveBeenCalled();
    });

    it('resolves a LID-only identity to its phone number through the stored mapping, and never invents a number without one', async () => {
      const qr = await import('../../../src/whatsapp/qrConnection');
      fixtures.lidPn = '966522222222@s.whatsapp.net';
      await open(qr, 2, { id: '123456789012345:4@lid', name: 'JOTUN' });
      expect(qr.getQrStatus(2)).toMatchObject({ phase: 'connected', phoneNumber: '+966522222222' });

      await qr.closeQrConnection();
      vi.resetModules();
      const fresh = await import('../../../src/whatsapp/qrConnection');
      fixtures.lidPn = null;
      fixtures.accounts[1]!.phoneNumber = null;
      fixtures.accounts[1]!.jid = null;
      await open(fresh, 2, { id: '123456789012345:4@lid' });
      expect(fresh.getQrStatus(2)).toMatchObject({ phase: 'connected', phoneNumber: null });
    });
  });
});
