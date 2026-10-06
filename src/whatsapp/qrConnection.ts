import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { env } from '../config/env';
import { getBusinessSettings } from '../config/businessSettings';
import { logger, maskWaId } from '../logger';
import { loadKnowledgeBase, type KnowledgeBase } from '../knowledge/loader';
import { processInboundMessage } from '../pipeline/processInboundMessage';
import { claimWebhookEvent, markWebhookEventProcessed, markWebhookEventFailed } from '../pipeline/idempotency';
import { getCustomerByWaId, setCustomerReplyJid } from '../memory/customerRepo';
import { canonicalJid, getPnForLid, rememberLidMapping } from '../memory/lidMapRepo';
import {
  getQrSession,
  setQrSessionStatus,
  recordQrSessionConnected,
  clearQrSessionIdentity,
  type QrSessionStatus,
} from '../memory/qrSessionRepo';
import { recordReplyActivity } from '../automation/settingsRepo';
import { replyTransport, type ReplyTransport } from './replyTransport';
import { isDirectChatJid, isLidJid, jidToPhoneNumber } from './jid';
import { registerOutboxSender, flushOutbox, NotConnectedError } from '../notifications/outbox';
import { parseOperatorCommand, handleOperatorCommand } from '../requests/requestService';

export const QR_CHANNEL = 'qr';

const AUTH_DIR = path.resolve(path.dirname(env.DATABASE_PATH), 'baileys-auth');
const QR_TTL_MS = 60_000;
const MAX_QR_ROUNDS = 5;
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;
/** Messages older than this when they arrive (offline backlog / reconnect replay) are stored but never auto-answered. */
const STALE_MESSAGE_MS = 10 * 60_000;
/** Ownership marker for the auth store: two live processes on one store desync every Signal session. */
const OWNER_FILE = path.resolve(path.dirname(AUTH_DIR), 'baileys-auth.owner.json');

let sock: WASocket | undefined;
let phase: QrSessionStatus = 'idle';
let detail = 'Connect WhatsApp by scanning the QR code.';
let qrDataUrl: string | null = null;
let qrExpiresAt = 0;
let qrRounds = 0;
let generation = 0;
let busy = false;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let stopRequested = false;
let knowledgeCache: KnowledgeBase | undefined;
let qrGeneratedAt = 0;
let lastConnectionEvent: QrDiagnostics['lastConnectionEvent'] = null;
let lastDisconnectCode: number | null = null;
const VERSION_FETCH_TIMEOUT_MS = 5_000;
/** Last WhatsApp Web version that worked. Reused when the lookup is slow and on every reconnect (no 5 s GitHub round-trip while the network is flapping). */
const VERSION_CACHE_FILE = path.resolve(path.dirname(AUTH_DIR), 'baileys-version.json');
let cachedVersion: [number, number, number] | undefined;
let versionSource: QrDiagnostics['versionSource'] = null;
/** Recent connection closes. Several within a few minutes = the network path to WhatsApp is unstable (codes 408/428), not a code fault. */
const closeTimes: number[] = [];
const DROP_WINDOW_MS = 10 * 60_000;
const UNSTABLE_DROPS = 3;
let connectedSince: string | null = null;

function noteConnectionEvent(type: string, statusCode: number | null = null): void {
  lastConnectionEvent = { type, at: new Date().toISOString(), statusCode };
}

function recentDrops(): number {
  const cutoff = Date.now() - DROP_WINDOW_MS;
  while (closeTimes.length && closeTimes[0]! < cutoff) closeTimes.shift();
  return closeTimes.length;
}

function readCachedVersion(): [number, number, number] | undefined {
  if (cachedVersion) return cachedVersion;
  try {
    if (fs.existsSync(VERSION_CACHE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(VERSION_CACHE_FILE, 'utf8')) as { version?: unknown };
      if (Array.isArray(saved.version) && saved.version.length === 3 && saved.version.every((n) => Number.isInteger(n))) {
        cachedVersion = saved.version as [number, number, number];
      }
    }
  } catch {
    /* unreadable cache = no cache */
  }
  return cachedVersion;
}

function rememberVersion(version: [number, number, number]): void {
  cachedVersion = version;
  try {
    fs.writeFileSync(VERSION_CACHE_FILE, JSON.stringify({ version, savedAt: new Date().toISOString() }));
  } catch (error) {
    logger.warn({ error }, 'could not persist the WhatsApp Web version cache');
  }
}

/**
 * WhatsApp answered 401 (loggedOut): the phone removed this device or WhatsApp
 * invalidated the session. The credentials are useless now, so they are moved
 * aside (kept locally as evidence, never copied anywhere) — deleted only if the
 * move itself fails. Keeps the last three archives.
 */
function archiveAuthStore(reason: string): string | null {
  const target = `${AUTH_DIR}.${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(AUTH_DIR, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    logger.warn({ error }, 'could not archive the auth store; deleting it instead');
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    return null;
  }
  try {
    const parent = path.dirname(AUTH_DIR);
    const prefix = `${path.basename(AUTH_DIR)}.${reason}-`;
    const archives = fs.readdirSync(parent).filter((name) => name.startsWith(prefix)).sort();
    for (const stale of archives.slice(0, Math.max(0, archives.length - 3))) fs.rmSync(path.join(parent, stale), { recursive: true, force: true });
  } catch {
    /* pruning is best effort */
  }
  return target;
}

function readOwnerPid(): number | null {
  try {
    if (!fs.existsSync(OWNER_FILE)) return null;
    const owner = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')) as { pid?: number };
    return owner.pid ?? null;
  } catch {
    return null;
  }
}

export interface QrDiagnostics {
  pid: number;
  port: number;
  cwd: string;
  socketGeneration: number;
  activeSockets: number;
  ownerPid: number | null;
  ownsAuthStore: boolean;
  lastQrAt: string | null;
  lastConnectionEvent: { type: string; at: string; statusCode: number | null } | null;
  lastDisconnectCode: number | null;
  /** ISO time the current socket reached 'open' (null while not connected). */
  connectedSince: string | null;
  /** Connection closes in the last 10 minutes — several in a row means the network path is unstable. */
  dropsLast10Min: number;
  networkUnstable: boolean;
  lastCloseAt: string | null;
  /** Where the WhatsApp Web version for the current socket came from. */
  versionSource: 'fetched' | 'cached' | 'library_default' | null;
}

export interface QrStatus {
  /** Server-side runtime facts for the connection page (never credentials). */
  diagnostics: QrDiagnostics;
  /** ISO time the current QR was generated (null when no QR is shown). */
  qrGeneratedAt: string | null;
  phase: QrSessionStatus;
  detail: string;
  qr: string | null;
  qrExpiresAt: string | null;
  available: boolean;
  phoneNumber: string | null;
  displayName: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastError: string | null;
  hasSavedSession: boolean;
  reconnectAttempts: number;
}

function hasSavedSession(): boolean {
  return fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
}

export function isQrAvailable(): boolean {
  return env.NODE_ENV !== 'test' && !process.env.VERCEL;
}

export function getQrStatus(): QrStatus {
  const persisted = getQrSession();
  const qrLive = qrDataUrl !== null && qrExpiresAt > Date.now();
  const ownerPid = readOwnerPid();
  return {
    phase,
    detail,
    qr: qrLive ? qrDataUrl : null,
    qrExpiresAt: qrLive ? new Date(qrExpiresAt).toISOString() : null,
    qrGeneratedAt: qrLive ? new Date(qrGeneratedAt).toISOString() : null,
    diagnostics: {
      pid: process.pid,
      port: env.PORT,
      cwd: process.cwd(),
      socketGeneration: generation,
      activeSockets: sock ? 1 : 0,
      ownerPid,
      ownsAuthStore: ownerPid === process.pid,
      lastQrAt: qrGeneratedAt ? new Date(qrGeneratedAt).toISOString() : null,
      lastConnectionEvent,
      lastDisconnectCode,
      connectedSince,
      dropsLast10Min: recentDrops(),
      networkUnstable: recentDrops() >= UNSTABLE_DROPS,
      lastCloseAt: closeTimes.length ? new Date(closeTimes[closeTimes.length - 1]!).toISOString() : null,
      versionSource,
    },
    available: isQrAvailable(),
    phoneNumber: persisted.phoneNumber,
    displayName: persisted.displayName,
    connectedAt: persisted.connectedAt,
    disconnectedAt: persisted.disconnectedAt,
    lastError: persisted.lastError,
    hasSavedSession: hasSavedSession(),
    reconnectAttempts,
  };
}

function setPhase(next: QrSessionStatus, message: string, error: string | null = null): void {
  phase = next;
  detail = message;
  if (next !== 'scan') {
    qrDataUrl = null;
    qrExpiresAt = 0;
  }
  try {
    if (next !== 'connected') setQrSessionStatus(next, error);
  } catch (err) {
    logger.warn({ err }, 'could not persist QR session status');
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Claims the Baileys auth store for this process. Refuses when another LIVE
 * process holds it (a stale marker from a crashed process is taken over).
 * Cooperative guard in addition to the HTTP-port fail-fast in index.ts.
 */
export function claimAuthStoreOwnership(): { ok: true } | { ok: false; pid: number } {
  try {
    if (fs.existsSync(OWNER_FILE)) {
      const owner = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')) as { pid?: number };
      if (owner.pid && owner.pid !== process.pid && pidAlive(owner.pid)) return { ok: false, pid: owner.pid };
    }
  } catch (error) {
    logger.warn({ error }, 'unreadable auth-store owner marker; taking ownership');
  }
  fs.writeFileSync(OWNER_FILE, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return { ok: true };
}

function releaseAuthStoreOwnership(): void {
  try {
    if (!fs.existsSync(OWNER_FILE)) return;
    const owner = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8')) as { pid?: number };
    if (owner.pid === process.pid) fs.unlinkSync(OWNER_FILE);
  } catch {
    /* best effort */
  }
}

/** Ids of messages this process sent — so our own outbound never looks like an operator command. */
const ownSentIds = new Set<string>();
function rememberSent(id: string | null | undefined): void {
  if (!id) return;
  ownSentIds.add(id);
  if (ownSentIds.size > 500) ownSentIds.delete(ownSentIds.values().next().value as string);
}

/** Outbox sender: only the current, connected socket may deliver; otherwise rows stay pending. */
registerOutboxSender(async (jid, text) => {
  if (!sock || phase !== 'connected') throw new NotConnectedError();
  const sent = await sock.sendMessage(jid, { text });
  rememberSent(sent?.key?.id);
  return sent?.key?.id ?? null;
});

function knowledge(): KnowledgeBase {
  if (!knowledgeCache) knowledgeCache = loadKnowledgeBase(path.resolve(__dirname, '../../knowledge'));
  return knowledgeCache;
}

function extractText(message: WAMessage): string {
  const m = message.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ''
  ).trim();
}

/** Flattens an interactive menu to numbered text; personal WhatsApp sessions have no button API. */
function renderInteractiveAsText(menu: Parameters<ReplyTransport['interactive']>[1]): { text: string; ids: string[] } {
  const rows = menu.kind === 'buttons' ? menu.buttons : menu.sections.flatMap((s) => s.rows);
  const lines = [
    menu.header,
    menu.body,
    ...rows.map((r, i) => `${i + 1}. ${r.title}`),
    menu.footer,
    'Reply with the option number / أرسل رقم الخيار',
  ].filter((line): line is string => Boolean(line));
  return { text: lines.join('\n\n'), ids: rows.map((r) => r.id) };
}

function buildTransport(instance: WASocket, run: number, replyJid: string): ReplyTransport {
  const target = maskWaId(replyJid);
  const send = async (body: string) => {
    logger.info({ target, jidServer: replyJid.split('@')[1], length: body.length }, '[WA-OUTBOUND] sendMessage started');
    if (run !== generation || phase !== 'connected') {
      logger.error({ target, phase }, '[WA-OUTBOUND] sendMessage aborted: session not connected');
      throw new Error('QR session is not connected');
    }
    try {
      const sent = await instance.sendMessage(replyJid, { text: body });
      rememberSent(sent?.key?.id);
      logger.info({ target, finalSendTarget: `${target}@${replyJid.split('@')[1]}`, sentId: sent?.key?.id ?? null }, '[WA-OUTBOUND] sendMessage success');
      return {
        messaging_product: 'whatsapp' as const,
        contacts: [{ input: replyJid, wa_id: replyJid }],
        messages: [{ id: sent?.key?.id ?? `qr-${Date.now()}` }],
      };
    } catch (error) {
      logger.error({ target, error }, '[WA-OUTBOUND] sendMessage failure');
      throw error;
    }
  };
  return {
    text: (_to, body) => send(body),
    interactive: async (_to, menu) => {
      const { text } = renderInteractiveAsText(menu);
      return send(text);
    },
  };
}

/**
 * Who we talk to, and who the customer is — deliberately two different things.
 *
 * REPLY ADDRESS: always key.remoteJid exactly as received. Baileys keys the
 * Signal session by that address; answering a "@lid" chat via the phone JID
 * opens a second session and the customer's next message fails to decrypt
 * ("Bad MAC" → 6-7 s retry delays, "Waiting for this message" on the phone).
 * The original Antigravity router replies to remoteJid and never hit this.
 *
 * CUSTOMER IDENTITY: the phone JID when we can know it — from key.senderPn,
 * or from a LID→phone pairing we saw earlier (retried/offline messages often
 * omit senderPn). Only when nothing better is known does the LID itself
 * identify the customer, so one person never becomes two records.
 */
export function resolveIdentity(message: WAMessage): { replyJid: string; customerJid: string; phoneJid: string | null } {
  const remote = message.key.remoteJid ?? '';
  const key = message.key as { senderPn?: string | null; senderLid?: string | null };
  const senderPn = key.senderPn && key.senderPn.endsWith('@s.whatsapp.net') ? canonicalJid(key.senderPn) : null;
  if (isLidJid(remote)) {
    let phoneJid = senderPn;
    if (phoneJid) rememberLidMapping(remote, phoneJid);
    else phoneJid = getPnForLid(remote);
    return { replyJid: remote, customerJid: phoneJid ?? canonicalJid(remote), phoneJid };
  }
  if (key.senderLid && key.senderLid.endsWith('@lid') && remote.endsWith('@s.whatsapp.net')) rememberLidMapping(key.senderLid, remote);
  return { replyJid: remote, customerJid: canonicalJid(remote), phoneJid: remote.endsWith('@s.whatsapp.net') ? canonicalJid(remote) : null };
}

async function handleInbound(instance: WASocket, run: number, message: WAMessage): Promise<void> {
  const remoteJid = message.key.remoteJid ?? '';
  const key = message.key as { senderPn?: string | null; participant?: string | null; senderLid?: string | null };
  const type = message.message ? Object.keys(message.message)[0] : 'none';
  logger.info(
    {
      remote: maskWaId(remoteJid),
      server: remoteJid.split('@')[1],
      fromMe: Boolean(message.key.fromMe),
      type,
      id: message.key.id ?? null,
      senderPn: key.senderPn ? `${maskWaId(key.senderPn)}@${key.senderPn.split('@')[1]}` : null,
      participant: key.participant ? maskWaId(key.participant) : null,
      pushName: message.pushName ? message.pushName.slice(0, 3) + '…' : null,
      stubType: message.messageStubType ?? null,
    },
    '[WA-INBOUND] messages.upsert received',
  );
  // Operator commands: typed by the business account itself (any of its devices) — "CONFIRM APT-2026-3777".
  // key.fromMe is the authorization: customers can never produce a fromMe message.
  if (message.key.fromMe && message.message && message.key.id && !ownSentIds.has(message.key.id) && isDirectChatJid(remoteJid)) {
    const command = parseOperatorCommand(extractText(message));
    if (command) {
      const eventId = `qr-op:${message.key.id}`;
      if (!claimWebhookEvent(eventId, 'operator command')) {
        logger.info({ id: eventId }, '[WA-OPERATOR] duplicate command event ignored');
        return;
      }
      try {
        const { text: result, result: outcome } = handleOperatorCommand(command, `whatsapp:${maskWaId(remoteJid)}`);
        logger.info({ reference: command.reference, status: command.status, changed: outcome?.changed ?? false }, '[WA-OPERATOR] command applied');
        const sent = await instance.sendMessage(remoteJid, { text: result });
        rememberSent(sent?.key?.id);
        markWebhookEventProcessed(eventId);
      } catch (error) {
        markWebhookEventFailed(eventId, 'operator command failed');
        logger.error({ error, reference: command.reference }, '[WA-OPERATOR] command failed');
      }
      return;
    }
  }
  if (message.key.fromMe || !message.message || !isDirectChatJid(remoteJid)) {
    const reason = message.key.fromMe
      ? 'fromMe'
      : !message.message
        ? message.messageStubType
          ? `undecryptable(stub=${message.messageStubType})`
          : 'empty'
        : 'not-direct-chat';
    logger.info({ remote: maskWaId(remoteJid), reason }, '[WA-INBOUND] filtered');
    return;
  }
  const { replyJid, customerJid, phoneJid } = resolveIdentity(message);
  const text = extractText(message);
  const messageId = message.key.id ? `qr:${message.key.id}` : null;
  const sentAt = Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000;
  logger.info(
    {
      customer: maskWaId(customerJid),
      customerServer: customerJid.split('@')[1],
      replyTo: `${maskWaId(replyJid)}@${replyJid.split('@')[1]}`,
      phoneKnown: Boolean(phoneJid),
      senderLid: key.senderLid ? maskWaId(key.senderLid) : null,
      messageId,
      socketGeneration: run,
      textLength: text.length,
      preview: text.slice(0, 24),
      ageSeconds: Math.round((Date.now() - sentAt) / 1000),
    },
    '[WA-INBOUND] accepted',
  );
  if (!messageId) return;
  if (!claimWebhookEvent(messageId, 'QR direct message')) {
    logger.info({ id: messageId }, '[WA-INBOUND] duplicate — already processed');
    return;
  }
  if (Date.now() - sentAt > STALE_MESSAGE_MS) {
    // Offline backlog delivered on (re)connect: never auto-answer old messages.
    markWebhookEventProcessed(messageId);
    recordReplyActivity({ waId: customerJid, channel: QR_CHANNEL, kind: 'suppressed', detail: 'Stale message delivered after reconnect — not auto-answered' });
    logger.info({ customer: maskWaId(customerJid), ageSeconds: Math.round((Date.now() - sentAt) / 1000) }, '[WA-INBOUND] filtered stale');
    return;
  }

  const transport = buildTransport(instance, run, replyJid);
  await replyTransport.run(transport, async () => {
    try {
      logger.info({ customer: maskWaId(customerJid), type: text ? 'text' : 'unsupported' }, '[WA-INBOUND] processInboundMessage started');
      await processInboundMessage(
        {
          waId: customerJid,
          messageId,
          timestamp: sentAt,
          type: text ? 'text' : 'unsupported',
          text: text || undefined,
          contactName: message.pushName ?? undefined,
          channel: QR_CHANNEL,
        },
        { knowledge: knowledge() },
      );
      const customer = getCustomerByWaId(customerJid);
      if (customer) setCustomerReplyJid(customer.id, replyJid);
      markWebhookEventProcessed(messageId);
      logger.info({ customer: maskWaId(customerJid) }, '[WA-INBOUND] processInboundMessage completed');
    } catch (error) {
      markWebhookEventFailed(messageId, 'QR message processing failed');
      recordReplyActivity({ waId: customerJid, channel: QR_CHANNEL, kind: 'error', detail: 'QR message processing failed' });
      logger.error({ customer: maskWaId(customerJid), error }, '[WA-INBOUND] processInboundMessage failed');
    }
  });
}

function scheduleReconnect(run: number, forcedDelayMs?: number): void {
  // First retry is immediate-ish (WhatsApp drops idle sockets with 428 routinely); backoff only if it keeps failing.
  const computed = reconnectAttempts === 0 ? 1_000 : Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempts - 1), RECONNECT_MAX_MS);
  const delay = forcedDelayMs ?? computed;
  reconnectAttempts += 1;
  const drops = recentDrops();
  const seconds = Math.round(delay / 1000);
  if (drops >= UNSTABLE_DROPS) {
    logger.warn({ drops, windowMinutes: DROP_WINDOW_MS / 60_000, lastDisconnectCode }, '[WA-SESSION] unstable network: repeated connection drops');
    setPhase(
      'reconnecting',
      `Connection dropped ${drops} times in the last 10 minutes (WhatsApp code ${lastDisconnectCode ?? 'unknown'}) — the network between this server and WhatsApp is unstable. Reconnecting in ${seconds}s…`,
    );
  } else {
    setPhase('reconnecting', `Connection interrupted. Reconnecting in ${seconds}s…`);
  }
  reconnectTimer = setTimeout(() => {
    if (run !== generation || stopRequested) return;
    // The guard in startQrConnection skips 'connecting'/'reconnecting'; this timer IS the reconnect.
    if (phase === 'reconnecting' || phase === 'connecting') phase = 'idle';
    void startQrConnection().catch((error) => logger.warn({ error }, 'QR reconnect failed'));
  }, delay);
  reconnectTimer.unref();
}

export async function startQrConnection(): Promise<void> {
  if (!isQrAvailable()) throw new Error('QR linking requires a persistent Node server (not test or serverless).');
  if (busy || ['starting', 'scan', 'connecting', 'connected'].includes(phase)) return;
  busy = true;
  stopRequested = false;
  clearTimeout(reconnectTimer);
  const run = ++generation;
  qrRounds = 0;
  setPhase('starting', 'Opening a secure WhatsApp session…');
  try {
    if (sock) {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.end(undefined);
      sock = undefined;
    }
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const ownership = claimAuthStoreOwnership();
    if (!ownership.ok) {
      setPhase('error', `Another server process (pid ${ownership.pid}) already owns this WhatsApp session. Stop it first.`, 'auth_store_owned');
      logger.error({ ownerPid: ownership.pid }, 'refusing to open a second Baileys socket on the same auth store');
      return;
    }
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    // Never let a slow version lookup keep the page on "Preparing session…".
    let version: [number, number, number] | undefined;
    const cached = readCachedVersion();
    if (cached && reconnectAttempts > 0) {
      // Reconnecting after a drop: reuse the version that just worked instead of a 5 s GitHub round-trip on a flaky network.
      version = cached;
      versionSource = 'cached';
    } else {
      try {
        const fetched = await Promise.race([
          fetchLatestBaileysVersion(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('version lookup timed out')), VERSION_FETCH_TIMEOUT_MS).unref()),
        ]);
        version = fetched.version as [number, number, number];
        versionSource = 'fetched';
        rememberVersion(version);
      } catch (error) {
        version = cached;
        versionSource = cached ? 'cached' : 'library_default';
        logger.warn({ error: (error as Error).message, fallback: versionSource }, 'Baileys version lookup failed; using the fallback version');
      }
    }
    const instance = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: [getBusinessSettings().businessName, 'Chrome', '120.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 20_000,
      defaultQueryTimeoutMs: 60_000,
    });
    noteConnectionEvent('socket_created');
    logger.info(
      { pid: process.pid, port: env.PORT, cwd: process.cwd(), socketGeneration: run, ownerPid: readOwnerPid(), hasSavedSession: hasSavedSession() },
      '[WA-SESSION] socket created',
    );
    sock = instance;

    instance.ev.on('creds.update', saveCreds);

    instance.ev.on('connection.update', async (update) => {
      if (run !== generation) return;
      const { connection, lastDisconnect, qr } = update;
      if (update.isNewLogin) {
        noteConnectionEvent('paired');
        setPhase('connecting', 'Phone scanned and paired. Finishing sign-in…');
        logger.info({ socketGeneration: run }, '[WA-SESSION] QR scanned — new login');
      }

      if (qr) {
        qrRounds += 1;
        noteConnectionEvent('qr');
        if (qrRounds > MAX_QR_ROUNDS) {
          setPhase('qr_expired', 'QR code expired. Click Refresh QR to generate a new one.');
          instance.end(undefined);
          return;
        }
        try {
          qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
          qrExpiresAt = Date.now() + QR_TTL_MS;
          qrGeneratedAt = Date.now();
          phase = 'scan';
          detail = 'Scan with WhatsApp → Linked devices → Link a device.';
          setQrSessionStatus('scan');
        } catch (error) {
          setPhase('error', 'Could not render the QR code. Try again.', 'qr_render_failed');
          logger.warn({ error }, 'QR render failed');
        }
      }

      if (connection === 'connecting') {
        noteConnectionEvent('connecting');
        if (phase !== 'scan') setPhase('connecting', hasSavedSession() ? 'Restoring the saved session…' : 'Phone linked. Waiting for WhatsApp to finish syncing…');
      }

      if (connection === 'open') {
        reconnectAttempts = 0;
        lastDisconnectCode = null;
        connectedSince = new Date().toISOString();
        noteConnectionEvent('open');
        const me = instance.user ?? state.creds.me;
        const jid = me?.id ?? '';
        const phoneNumber = jidToPhoneNumber(jid);
        recordQrSessionConnected({ phoneNumber, jid, displayName: me?.name ?? null });
        phase = 'connected';
        qrDataUrl = null;
        qrExpiresAt = 0;
        detail = phoneNumber
          ? `Connected as ${phoneNumber}. New direct messages are answered automatically.`
          : 'Connected. New direct messages are answered automatically.';
        logger.info({ phone: maskWaId(phoneNumber ?? jid) }, 'WhatsApp QR session connected');
        void flushOutbox().catch((error) => logger.warn({ error }, '[OUTBOX] flush after connect failed'));
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        lastDisconnectCode = statusCode ?? null;
        connectedSince = null;
        closeTimes.push(Date.now());
        if (closeTimes.length > 50) closeTimes.shift();
        noteConnectionEvent('close', statusCode ?? null);
        if (stopRequested) return;
        if (statusCode === DisconnectReason.restartRequired) {
          // Normal right after a fresh QR scan: WhatsApp asks for one reconnect to complete sign-in.
          logger.info({ statusCode }, '[WA-SESSION] restart required after pairing — reconnecting');
          scheduleReconnect(run, 1_000);
          setPhase('connecting', 'Phone paired. Restarting the session to finish sign-in…');
          return;
        }
        if (statusCode === DisconnectReason.loggedOut) {
          const archived = archiveAuthStore('loggedout');
          logger.warn(
            { statusCode, archivedTo: archived ? path.basename(archived) : null },
            'WhatsApp reported loggedOut (code 401: the phone removed this device or WhatsApp invalidated the session) — credentials archived, a new QR scan is required',
          );
          clearQrSessionIdentity();
          setPhase('logged_out', 'WhatsApp logged this device out (code 401). Scan a new QR code to connect again.', 'logged_out_by_whatsapp_401');
          return;
        }
        if (phase === 'qr_expired' || (statusCode === DisconnectReason.timedOut && !hasSavedSession())) {
          setPhase('qr_expired', 'QR code expired. Click Refresh QR to generate a new one.');
          return;
        }
        logger.warn({ statusCode }, 'WhatsApp QR connection closed');
        scheduleReconnect(run);
      }
    });

    instance.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        if (!u.key.fromMe) continue;
        logger.info({ id: u.key.id, to: maskWaId(u.key.remoteJid ?? ''), status: u.update.status ?? null }, '[WA-ACK] outbound status update');
      }
    });

    const learnContacts = (contacts: Array<{ id?: string | null; lid?: string | null }>) => {
      for (const c of contacts) {
        if (c.id && c.lid && c.id.endsWith('@s.whatsapp.net') && c.lid.endsWith('@lid')) {
          try { rememberLidMapping(c.lid, c.id); } catch (error) { logger.warn({ error }, 'could not store LID mapping'); }
        }
      }
    };
    instance.ev.on('contacts.upsert', learnContacts);
    instance.ev.on('contacts.update', (updates) => learnContacts(updates as Array<{ id?: string | null; lid?: string | null }>));

    instance.ev.on('messages.upsert', ({ messages, type }) => {
      if (run !== generation || type !== 'notify' || phase !== 'connected') return;
      for (const message of messages) {
        void handleInbound(instance, run, message);
      }
    });
  } catch (error) {
    setPhase('error', 'Could not create a WhatsApp session. Check server storage and retry.', String((error as Error)?.message ?? error));
    throw error;
  } finally {
    busy = false;
  }
}

/** Generates a fresh QR after expiry without touching a saved session. */
/**
 * "Refresh QR Code": a new code when pairing is pending/expired. Never touches
 * a healthy connected session and never deletes credentials.
 */
export async function refreshQrConnection(): Promise<{ notice: 'already_connected' | 'busy' | 'refreshed' }> {
  if (phase === 'connected') return { notice: 'already_connected' };
  if (busy || phase === 'connecting' || phase === 'starting') return { notice: 'busy' };
  if (phase === 'scan' && sock) {
    // Drop the pairing socket (its close event is ignored by the generation guard) and open a new one → fresh QR.
    ++generation;
    const old = sock;
    sock = undefined;
    old.ev.removeAllListeners('connection.update');
    old.ev.removeAllListeners('messages.upsert');
    try { old.end(undefined); } catch { /* already closed */ }
  }
  clearTimeout(reconnectTimer);
  phase = 'idle';
  qrDataUrl = null;
  await startQrConnection();
  return { notice: 'refreshed' };
}

/**
 * "Retry Connection": only when disconnected / reconnecting / failed. Uses the
 * normal start path (same guards, same single socket), resetting the backoff.
 */
export async function retryQrConnection(): Promise<{ notice: 'retrying' | 'not_needed' }> {
  if (['connected', 'connecting', 'starting', 'scan'].includes(phase) || busy) return { notice: 'not_needed' };
  clearTimeout(reconnectTimer);
  reconnectAttempts = 0;
  if (sock) {
    ++generation;
    const old = sock;
    sock = undefined;
    try { old.end(undefined); } catch { /* already closed */ }
  }
  phase = 'idle';
  await startQrConnection();
  return { notice: 'retrying' };
}

/** Logs the linked phone out and clears stored credentials so a different number can pair. */
export async function stopQrConnection(): Promise<void> {
  if (busy) throw new Error('Connection is changing. Try again shortly.');
  busy = true;
  stopRequested = true;
  clearTimeout(reconnectTimer);
  ++generation;
  try {
    const instance = sock;
    sock = undefined;
    if (instance) {
      try {
        await instance.logout();
      } catch {
        instance.end(undefined);
      }
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    clearQrSessionIdentity();
    reconnectAttempts = 0;
    setPhase('logged_out', 'Disconnected. Scan a QR code to link a phone.');
  } finally {
    busy = false;
  }
}

/** On boot: resume a saved session, or start pairing so the dashboard shows a QR immediately. */
export function resumeQrConnection(): void {
  if (!isQrAvailable()) return;
  void startQrConnection().catch((error) => logger.warn({ error }, 'QR session start failed at boot'));
}

export async function closeQrConnection(): Promise<void> {
  releaseAuthStoreOwnership();
  ++generation;
  stopRequested = true;
  clearTimeout(reconnectTimer);
  sock?.end(undefined);
  sock = undefined;
}
