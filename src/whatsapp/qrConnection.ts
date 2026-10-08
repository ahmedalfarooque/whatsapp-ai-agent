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
import { knowledgeDirForAccount } from '../knowledge/paths';
import { processInboundMessage } from '../pipeline/processInboundMessage';
import { claimWebhookEvent, markWebhookEventProcessed, markWebhookEventFailed } from '../pipeline/idempotency';
import { getCustomerByWaId, setCustomerReplyJid } from '../memory/customerRepo';
import { canonicalJid, getPnForLid, rememberLidMapping } from '../memory/lidMapRepo';
import {
  getAccount,
  listEnabledAccounts,
  authDirFor,
  dataDir,
  setAccountStatus,
  recordAccountConnected,
  clearAccountIdentity,
  type AccountSessionStatus,
  type WhatsappAccount,
} from '../accounts/accountRepo';
import { LEGACY_ACCOUNT_ID, runWithAccount } from '../accounts/accountContext';
import { recordReplyActivity } from '../automation/settingsRepo';
import { replyTransport, type ReplyTransport } from './replyTransport';
import type { OutboundDocument } from './types';
import { isDirectChatJid, isLidJid, jidToPhoneNumber } from './jid';
import { registerOutboxSender, flushOutbox, NotConnectedError } from '../notifications/outbox';
import { parseOperatorCommand, handleOperatorCommand } from '../requests/requestService';

/**
 * WhatsApp linked-device (QR / Baileys) connections — ONE PER ACCOUNT.
 *
 * Every WhatsApp account (business) owns a QrConnection: its own socket, auth
 * directory, QR state, reconnect backoff, 401/515 handling, owner marker and
 * sent-message ids. Nothing is shared between accounts except the WhatsApp
 * Web version cache. A message arriving on account B's socket is processed
 * inside account B's context and answered through account B's socket; a
 * failure, reconnect, refresh or logout of one account never touches another.
 *
 * The module-level functions keep the original single-account names and
 * default to the legacy account (1), so existing callers and tests behave
 * exactly as before; new callers pass the account id explicitly.
 */

export const QR_CHANNEL = 'qr';

const QR_TTL_MS = 60_000;
const MAX_QR_ROUNDS = 5;
const RECONNECT_BASE_MS = 3_000;
const RECONNECT_MAX_MS = 60_000;
/** Messages older than this when they arrive (offline backlog / reconnect replay) are stored but never auto-answered. */
const STALE_MESSAGE_MS = 10 * 60_000;
const VERSION_FETCH_TIMEOUT_MS = 5_000;
/** Recent connection closes. Several within a few minutes = the network path to WhatsApp is unstable (codes 408/428), not a code fault. */
const DROP_WINDOW_MS = 10 * 60_000;
const UNSTABLE_DROPS = 3;

export type QrSessionStatus = AccountSessionStatus;

export interface QrDiagnostics {
  accountId: number;
  pid: number;
  port: number;
  cwd: string;
  socketGeneration: number;
  /** Sockets open for THIS account (0 or 1). */
  activeSockets: number;
  /** Sockets open across all accounts in this process. */
  totalActiveSockets: number;
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
  accountId: number;
  accountName: string;
  enabled: boolean;
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

export function isQrAvailable(): boolean {
  return env.NODE_ENV !== 'test' && !process.env.VERCEL;
}

// ------------------------------------------------------------------ shared: WhatsApp Web version cache (one file for all accounts)

/** Last WhatsApp Web version that worked. Reused when the lookup is slow and on every reconnect (no 5 s GitHub round-trip while the network is flapping). */
function versionCacheFile(): string {
  return path.resolve(dataDir(), 'baileys-version.json');
}
let cachedVersion: [number, number, number] | undefined;

function readCachedVersion(): [number, number, number] | undefined {
  if (cachedVersion) return cachedVersion;
  try {
    if (fs.existsSync(versionCacheFile())) {
      const saved = JSON.parse(fs.readFileSync(versionCacheFile(), 'utf8')) as { version?: unknown };
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
    fs.writeFileSync(versionCacheFile(), JSON.stringify({ version, savedAt: new Date().toISOString() }));
  } catch (error) {
    logger.warn({ error }, 'could not persist the WhatsApp Web version cache');
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

// ------------------------------------------------------------------ one account's connection

class QrConnection {
  readonly accountId: number;
  private sock: WASocket | undefined;
  private phase: QrSessionStatus = 'idle';
  private detail = 'Connect WhatsApp by scanning the QR code.';
  private qrDataUrl: string | null = null;
  private qrExpiresAt = 0;
  private qrRounds = 0;
  private generation = 0;
  private busy = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopRequested = false;
  private knowledgeCache: KnowledgeBase | undefined;
  private qrGeneratedAt = 0;
  private lastConnectionEvent: QrDiagnostics['lastConnectionEvent'] = null;
  private lastDisconnectCode: number | null = null;
  private versionSource: QrDiagnostics['versionSource'] = null;
  private readonly closeTimes: number[] = [];
  private connectedSince: string | null = null;
  /** Ids of messages this account sent — so our own outbound never looks like an operator command. */
  private readonly ownSentIds = new Set<string>();

  constructor(accountId: number) {
    this.accountId = accountId;
  }

  // ---- paths (resolved on use: the account's auth_dir is persisted, the data dir comes from env)

  private account(): WhatsappAccount {
    const account = getAccount(this.accountId);
    if (!account) throw new Error(`whatsapp account ${this.accountId} does not exist`);
    return account;
  }

  authDir(): string {
    return authDirFor(this.account());
  }

  /** Ownership marker for the auth store: two live processes on one store desync every Signal session. */
  private ownerFile(): string {
    return path.resolve(path.dirname(this.authDir()), `${path.basename(this.authDir())}.owner.json`);
  }

  hasSavedSession(): boolean {
    return fs.existsSync(path.join(this.authDir(), 'creds.json'));
  }

  isConnected(): boolean {
    return this.phase === 'connected' && this.sock !== undefined;
  }

  hasSocket(): boolean {
    return this.sock !== undefined;
  }

  currentPhase(): QrSessionStatus {
    return this.phase;
  }

  // ---- diagnostics

  private noteConnectionEvent(type: string, statusCode: number | null = null): void {
    this.lastConnectionEvent = { type, at: new Date().toISOString(), statusCode };
  }

  private recentDrops(): number {
    const cutoff = Date.now() - DROP_WINDOW_MS;
    while (this.closeTimes.length && this.closeTimes[0]! < cutoff) this.closeTimes.shift();
    return this.closeTimes.length;
  }

  private readOwnerPid(): number | null {
    try {
      const file = this.ownerFile();
      if (!fs.existsSync(file)) return null;
      const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
      return owner.pid ?? null;
    } catch {
      return null;
    }
  }

  status(): QrStatus {
    const account = this.account();
    const qrLive = this.qrDataUrl !== null && this.qrExpiresAt > Date.now();
    const ownerPid = this.readOwnerPid();
    return {
      accountId: this.accountId,
      accountName: account.name,
      enabled: account.enabled,
      phase: this.phase,
      detail: this.detail,
      qr: qrLive ? this.qrDataUrl : null,
      qrExpiresAt: qrLive ? new Date(this.qrExpiresAt).toISOString() : null,
      qrGeneratedAt: qrLive ? new Date(this.qrGeneratedAt).toISOString() : null,
      diagnostics: {
        accountId: this.accountId,
        pid: process.pid,
        port: env.PORT,
        cwd: process.cwd(),
        socketGeneration: this.generation,
        activeSockets: this.sock ? 1 : 0,
        totalActiveSockets: countActiveSockets(),
        ownerPid,
        ownsAuthStore: ownerPid === process.pid,
        lastQrAt: this.qrGeneratedAt ? new Date(this.qrGeneratedAt).toISOString() : null,
        lastConnectionEvent: this.lastConnectionEvent,
        lastDisconnectCode: this.lastDisconnectCode,
        connectedSince: this.connectedSince,
        dropsLast10Min: this.recentDrops(),
        networkUnstable: this.recentDrops() >= UNSTABLE_DROPS,
        lastCloseAt: this.closeTimes.length ? new Date(this.closeTimes[this.closeTimes.length - 1]!).toISOString() : null,
        versionSource: this.versionSource,
      },
      available: isQrAvailable(),
      phoneNumber: account.phoneNumber,
      displayName: account.displayName,
      connectedAt: account.connectedAt,
      disconnectedAt: account.disconnectedAt,
      lastError: account.lastError,
      hasSavedSession: this.hasSavedSession(),
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  private setPhase(next: QrSessionStatus, message: string, error: string | null = null): void {
    this.phase = next;
    this.detail = message;
    if (next !== 'scan') {
      this.qrDataUrl = null;
      this.qrExpiresAt = 0;
    }
    try {
      if (next !== 'connected') setAccountStatus(this.accountId, next, error);
    } catch (err) {
      logger.warn({ err, account: this.accountId }, 'could not persist QR session status');
    }
  }

  // ---- auth store ownership (per account directory)

  /**
   * Claims this account's auth store for this process. Refuses when another
   * LIVE process holds it (a stale marker from a crashed process is taken
   * over). Cooperative guard in addition to the HTTP-port fail-fast in index.ts.
   */
  claimAuthStoreOwnership(): { ok: true } | { ok: false; pid: number } {
    const file = this.ownerFile();
    try {
      if (fs.existsSync(file)) {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
        if (owner.pid && owner.pid !== process.pid && pidAlive(owner.pid)) return { ok: false, pid: owner.pid };
      }
    } catch (error) {
      logger.warn({ error, account: this.accountId }, 'unreadable auth-store owner marker; taking ownership');
    }
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, accountId: this.accountId, startedAt: new Date().toISOString() }));
    return { ok: true };
  }

  private releaseAuthStoreOwnership(): void {
    try {
      const file = this.ownerFile();
      if (!fs.existsSync(file)) return;
      const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
      if (owner.pid === process.pid) fs.unlinkSync(file);
    } catch {
      /* best effort */
    }
  }

  /**
   * WhatsApp answered 401 (loggedOut): the phone removed this device or
   * WhatsApp invalidated the session. The credentials are useless now, so they
   * are moved aside (kept locally as evidence, never copied anywhere) — deleted
   * only if the move itself fails. Keeps the last three archives. Only THIS
   * account's directory is touched.
   */
  private archiveAuthStore(reason: string): string | null {
    const authDir = this.authDir();
    const target = `${authDir}.${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(authDir, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      logger.warn({ error, account: this.accountId }, 'could not archive the auth store; deleting it instead');
      fs.rmSync(authDir, { recursive: true, force: true });
      return null;
    }
    try {
      const parent = path.dirname(authDir);
      const prefix = `${path.basename(authDir)}.${reason}-`;
      const archives = fs.readdirSync(parent).filter((name) => name.startsWith(prefix)).sort();
      for (const stale of archives.slice(0, Math.max(0, archives.length - 3))) fs.rmSync(path.join(parent, stale), { recursive: true, force: true });
    } catch {
      /* pruning is best effort */
    }
    return target;
  }

  private rememberSent(id: string | null | undefined): void {
    if (!id) return;
    this.ownSentIds.add(id);
    if (this.ownSentIds.size > 500) this.ownSentIds.delete(this.ownSentIds.values().next().value as string);
  }

  private knowledge(): KnowledgeBase {
    if (!this.knowledgeCache) this.knowledgeCache = loadKnowledgeBase(knowledgeDirForAccount(this.accountId));
    return this.knowledgeCache;
  }

  /** Forget the cached knowledge so a dashboard edit is picked up on the next message. */
  invalidateKnowledge(): void {
    this.knowledgeCache = undefined;
  }

  // ---- outbound

  /** Delivers one notification through this account's socket (the outbox sender). */
  async send(jid: string, text: string): Promise<string | null> {
    if (!this.sock || this.phase !== 'connected') throw new NotConnectedError(this.accountId);
    const sent = await this.sock.sendMessage(jid, { text });
    this.rememberSent(sent?.key?.id);
    return sent?.key?.id ?? null;
  }

  private buildTransport(instance: WASocket, run: number, replyJid: string): ReplyTransport {
    const target = maskWaId(replyJid);
    const send = async (body: string) => {
      logger.info({ account: this.accountId, target, jidServer: replyJid.split('@')[1], length: body.length }, '[WA-OUTBOUND] sendMessage started');
      if (run !== this.generation || this.phase !== 'connected') {
        logger.error({ account: this.accountId, target, phase: this.phase }, '[WA-OUTBOUND] sendMessage aborted: session not connected');
        throw new Error(`WhatsApp account ${this.accountId} is not connected`);
      }
      try {
        const sent = await instance.sendMessage(replyJid, { text: body });
        this.rememberSent(sent?.key?.id);
        logger.info({ account: this.accountId, target, finalSendTarget: `${target}@${replyJid.split('@')[1]}`, sentId: sent?.key?.id ?? null }, '[WA-OUTBOUND] sendMessage success');
        return {
          messaging_product: 'whatsapp' as const,
          contacts: [{ input: replyJid, wa_id: replyJid }],
          messages: [{ id: sent?.key?.id ?? `qr-${Date.now()}` }],
        };
      } catch (error) {
        logger.error({ account: this.accountId, target, error }, '[WA-OUTBOUND] sendMessage failure');
        throw error;
      }
    };
    // Catalogue PDFs: the same socket and the same connected-session guard as text, as a separate method so the
    // text path above is unchanged.
    const sendFile = async (file: OutboundDocument) => {
      logger.info({ account: this.accountId, target, jidServer: replyJid.split('@')[1], bytes: file.bytes.length }, '[WA-OUTBOUND] sendDocument started');
      if (run !== this.generation || this.phase !== 'connected') {
        logger.error({ account: this.accountId, target, phase: this.phase }, '[WA-OUTBOUND] sendDocument aborted: session not connected');
        throw new Error(`WhatsApp account ${this.accountId} is not connected`);
      }
      try {
        const sent = await instance.sendMessage(replyJid, { document: file.bytes, mimetype: file.mimeType, fileName: file.fileName, caption: file.caption });
        this.rememberSent(sent?.key?.id);
        logger.info({ account: this.accountId, target, sentId: sent?.key?.id ?? null }, '[WA-OUTBOUND] sendDocument success');
        return {
          messaging_product: 'whatsapp' as const,
          contacts: [{ input: replyJid, wa_id: replyJid }],
          messages: [{ id: sent?.key?.id ?? `qr-${Date.now()}` }],
        };
      } catch (error) {
        logger.error({ account: this.accountId, target, error }, '[WA-OUTBOUND] sendDocument failure');
        throw error;
      }
    };
    return {
      text: (_to, body) => send(body),
      interactive: async (_to, menu) => {
        const { text } = renderInteractiveAsText(menu);
        return send(text);
      },
      document: (_to, file) => sendFile(file),
    };
  }

  // ---- inbound

  private async handleInbound(instance: WASocket, run: number, message: WAMessage): Promise<void> {
    const remoteJid = message.key.remoteJid ?? '';
    const key = message.key as { senderPn?: string | null; participant?: string | null; senderLid?: string | null };
    const type = message.message ? Object.keys(message.message)[0] : 'none';
    logger.info(
      {
        account: this.accountId,
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
    // key.fromMe is the authorization: customers can never produce a fromMe message. Scoped to this account's requests.
    if (message.key.fromMe && message.message && message.key.id && !this.ownSentIds.has(message.key.id) && isDirectChatJid(remoteJid)) {
      const command = parseOperatorCommand(extractText(message));
      if (command) {
        const eventId = this.accountId === LEGACY_ACCOUNT_ID ? `qr-op:${message.key.id}` : `qr-op:${this.accountId}:${message.key.id}`;
        if (!claimWebhookEvent(eventId, 'operator command')) {
          logger.info({ id: eventId }, '[WA-OPERATOR] duplicate command event ignored');
          return;
        }
        try {
          const { text: result, result: outcome } = runWithAccount(this.accountId, () =>
            handleOperatorCommand(command, `whatsapp:${maskWaId(remoteJid)}`, undefined, this.accountId),
          );
          logger.info({ account: this.accountId, reference: command.reference, status: command.status, changed: outcome?.changed ?? false }, '[WA-OPERATOR] command applied');
          const sent = await instance.sendMessage(remoteJid, { text: result });
          this.rememberSent(sent?.key?.id);
          markWebhookEventProcessed(eventId);
        } catch (error) {
          markWebhookEventFailed(eventId, 'operator command failed');
          logger.error({ account: this.accountId, error, reference: command.reference }, '[WA-OPERATOR] command failed');
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
      logger.info({ account: this.accountId, remote: maskWaId(remoteJid), reason }, '[WA-INBOUND] filtered');
      return;
    }
    const { replyJid, customerJid, phoneJid } = resolveIdentity(message);
    const text = extractText(message);
    // Event ids are namespaced per account: the same phone sending the same message id to two businesses is two events.
    const messageId = message.key.id ? (this.accountId === LEGACY_ACCOUNT_ID ? `qr:${message.key.id}` : `qr:${this.accountId}:${message.key.id}`) : null;
    const sentAt = Number(message.messageTimestamp ?? Math.floor(Date.now() / 1000)) * 1000;
    logger.info(
      {
        account: this.accountId,
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
      recordReplyActivity({ waId: customerJid, channel: QR_CHANNEL, kind: 'suppressed', detail: 'Stale message delivered after reconnect — not auto-answered', accountId: this.accountId });
      logger.info({ account: this.accountId, customer: maskWaId(customerJid), ageSeconds: Math.round((Date.now() - sentAt) / 1000) }, '[WA-INBOUND] filtered stale');
      return;
    }

    const transport = this.buildTransport(instance, run, replyJid);
    await runWithAccount(this.accountId, () =>
      replyTransport.run(transport, async () => {
        try {
          logger.info({ account: this.accountId, customer: maskWaId(customerJid), type: text ? 'text' : 'unsupported' }, '[WA-INBOUND] processInboundMessage started');
          await processInboundMessage(
            {
              waId: customerJid,
              messageId,
              timestamp: sentAt,
              type: text ? 'text' : 'unsupported',
              text: text || undefined,
              contactName: message.pushName ?? undefined,
              channel: QR_CHANNEL,
              accountId: this.accountId,
            },
            { knowledge: this.knowledge() },
          );
          const customer = getCustomerByWaId(customerJid, undefined, this.accountId);
          if (customer) setCustomerReplyJid(customer.id, replyJid);
          markWebhookEventProcessed(messageId);
          logger.info({ account: this.accountId, customer: maskWaId(customerJid) }, '[WA-INBOUND] processInboundMessage completed');
        } catch (error) {
          markWebhookEventFailed(messageId, 'QR message processing failed');
          recordReplyActivity({ waId: customerJid, channel: QR_CHANNEL, kind: 'error', detail: 'QR message processing failed', accountId: this.accountId });
          logger.error({ account: this.accountId, customer: maskWaId(customerJid), error }, '[WA-INBOUND] processInboundMessage failed');
        }
      }),
    );
  }

  // ---- lifecycle

  private scheduleReconnect(run: number, forcedDelayMs?: number): void {
    // First retry is immediate-ish (WhatsApp drops idle sockets with 428 routinely); backoff only if it keeps failing.
    const computed = this.reconnectAttempts === 0 ? 1_000 : Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);
    const delay = forcedDelayMs ?? computed;
    this.reconnectAttempts += 1;
    const drops = this.recentDrops();
    const seconds = Math.round(delay / 1000);
    if (drops >= UNSTABLE_DROPS) {
      logger.warn({ account: this.accountId, drops, windowMinutes: DROP_WINDOW_MS / 60_000, lastDisconnectCode: this.lastDisconnectCode }, '[WA-SESSION] unstable network: repeated connection drops');
      this.setPhase(
        'reconnecting',
        `Connection dropped ${drops} times in the last 10 minutes (WhatsApp code ${this.lastDisconnectCode ?? 'unknown'}) — the network between this server and WhatsApp is unstable. Reconnecting in ${seconds}s…`,
      );
    } else {
      this.setPhase('reconnecting', `Connection interrupted. Reconnecting in ${seconds}s…`);
    }
    this.reconnectTimer = setTimeout(() => {
      if (run !== this.generation || this.stopRequested) return;
      // The guard in start() skips 'connecting'/'reconnecting'; this timer IS the reconnect.
      if (this.phase === 'reconnecting' || this.phase === 'connecting') this.phase = 'idle';
      void this.start().catch((error) => logger.warn({ error, account: this.accountId }, 'QR reconnect failed'));
    }, delay);
    this.reconnectTimer.unref();
  }

  async start(): Promise<void> {
    if (!isQrAvailable()) throw new Error('QR linking requires a persistent Node server (not test or serverless).');
    const account = this.account();
    if (!account.enabled) throw new Error(`WhatsApp account ${this.accountId} (${account.name}) is disabled. Enable it before connecting.`);
    if (this.busy || ['starting', 'scan', 'connecting', 'connected'].includes(this.phase)) return;
    this.busy = true;
    this.stopRequested = false;
    clearTimeout(this.reconnectTimer);
    const run = ++this.generation;
    this.qrRounds = 0;
    this.setPhase('starting', 'Opening a secure WhatsApp session…');
    try {
      if (this.sock) {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.end(undefined);
        this.sock = undefined;
      }
      const authDir = this.authDir();
      fs.mkdirSync(authDir, { recursive: true });
      const ownership = this.claimAuthStoreOwnership();
      if (!ownership.ok) {
        this.setPhase('error', `Another server process (pid ${ownership.pid}) already owns this WhatsApp session. Stop it first.`, 'auth_store_owned');
        logger.error({ account: this.accountId, ownerPid: ownership.pid }, 'refusing to open a second Baileys socket on the same auth store');
        return;
      }
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      // Never let a slow version lookup keep the page on "Preparing session…".
      let version: [number, number, number] | undefined;
      const cached = readCachedVersion();
      if (cached && this.reconnectAttempts > 0) {
        // Reconnecting after a drop: reuse the version that just worked instead of a 5 s GitHub round-trip on a flaky network.
        version = cached;
        this.versionSource = 'cached';
      } else {
        try {
          const fetched = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('version lookup timed out')), VERSION_FETCH_TIMEOUT_MS).unref()),
          ]);
          version = fetched.version as [number, number, number];
          this.versionSource = 'fetched';
          rememberVersion(version);
        } catch (error) {
          version = cached;
          this.versionSource = cached ? 'cached' : 'library_default';
          logger.warn({ account: this.accountId, error: (error as Error).message, fallback: this.versionSource }, 'Baileys version lookup failed; using the fallback version');
        }
      }
      const instance = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: [getBusinessSettings(this.accountId).businessName, 'Chrome', '120.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 20_000,
        defaultQueryTimeoutMs: 60_000,
      });
      this.noteConnectionEvent('socket_created');
      logger.info(
        { account: this.accountId, pid: process.pid, port: env.PORT, cwd: process.cwd(), socketGeneration: run, ownerPid: this.readOwnerPid(), hasSavedSession: this.hasSavedSession() },
        '[WA-SESSION] socket created',
      );
      this.sock = instance;

      instance.ev.on('creds.update', saveCreds);

      instance.ev.on('connection.update', async (update) => {
        if (run !== this.generation) return;
        const { connection, lastDisconnect, qr } = update;
        if (update.isNewLogin) {
          this.noteConnectionEvent('paired');
          this.setPhase('connecting', 'Phone scanned and paired. Finishing sign-in…');
          logger.info({ account: this.accountId, socketGeneration: run }, '[WA-SESSION] QR scanned — new login');
        }

        if (qr) {
          this.qrRounds += 1;
          this.noteConnectionEvent('qr');
          if (this.qrRounds > MAX_QR_ROUNDS) {
            this.setPhase('qr_expired', 'QR code expired. Click Refresh QR to generate a new one.');
            instance.end(undefined);
            return;
          }
          try {
            this.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
            this.qrExpiresAt = Date.now() + QR_TTL_MS;
            this.qrGeneratedAt = Date.now();
            this.phase = 'scan';
            this.detail = 'Scan with WhatsApp → Linked devices → Link a device.';
            setAccountStatus(this.accountId, 'scan');
          } catch (error) {
            this.setPhase('error', 'Could not render the QR code. Try again.', 'qr_render_failed');
            logger.warn({ error, account: this.accountId }, 'QR render failed');
          }
        }

        if (connection === 'connecting') {
          this.noteConnectionEvent('connecting');
          if (this.phase !== 'scan') this.setPhase('connecting', this.hasSavedSession() ? 'Restoring the saved session…' : 'Phone linked. Waiting for WhatsApp to finish syncing…');
        }

        if (connection === 'open') {
          this.reconnectAttempts = 0;
          this.lastDisconnectCode = null;
          this.connectedSince = new Date().toISOString();
          this.noteConnectionEvent('open');
          const me = instance.user ?? state.creds.me;
          const jid = me?.id ?? '';
          const phoneNumber = jidToPhoneNumber(jid);
          recordAccountConnected(this.accountId, { phoneNumber, jid, displayName: me?.name ?? null });
          this.phase = 'connected';
          this.qrDataUrl = null;
          this.qrExpiresAt = 0;
          this.detail = phoneNumber
            ? `Connected as ${phoneNumber}. New direct messages are answered automatically.`
            : 'Connected. New direct messages are answered automatically.';
          logger.info({ account: this.accountId, phone: maskWaId(phoneNumber ?? jid) }, 'WhatsApp QR session connected');
          void flushOutbox().catch((error) => logger.warn({ error }, '[OUTBOX] flush after connect failed'));
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
          this.lastDisconnectCode = statusCode ?? null;
          this.connectedSince = null;
          this.closeTimes.push(Date.now());
          if (this.closeTimes.length > 50) this.closeTimes.shift();
          this.noteConnectionEvent('close', statusCode ?? null);
          if (this.stopRequested) return;
          if (statusCode === DisconnectReason.restartRequired) {
            // Normal right after a fresh QR scan: WhatsApp asks for one reconnect to complete sign-in.
            logger.info({ account: this.accountId, statusCode }, '[WA-SESSION] restart required after pairing — reconnecting');
            this.scheduleReconnect(run, 1_000);
            this.setPhase('connecting', 'Phone paired. Restarting the session to finish sign-in…');
            return;
          }
          if (statusCode === DisconnectReason.loggedOut) {
            const archived = this.archiveAuthStore('loggedout');
            logger.warn(
              { account: this.accountId, statusCode, archivedTo: archived ? path.basename(archived) : null },
              'WhatsApp reported loggedOut (code 401: the phone removed this device or WhatsApp invalidated the session) — credentials archived, a new QR scan is required',
            );
            clearAccountIdentity(this.accountId);
            this.setPhase('logged_out', 'WhatsApp logged this device out (code 401). Scan a new QR code to connect again.', 'logged_out_by_whatsapp_401');
            return;
          }
          if (this.phase === 'qr_expired' || (statusCode === DisconnectReason.timedOut && !this.hasSavedSession())) {
            this.setPhase('qr_expired', 'QR code expired. Click Refresh QR to generate a new one.');
            return;
          }
          logger.warn({ account: this.accountId, statusCode }, 'WhatsApp QR connection closed');
          this.scheduleReconnect(run);
        }
      });

      instance.ev.on('messages.update', (updates) => {
        for (const u of updates) {
          if (!u.key.fromMe) continue;
          logger.info({ account: this.accountId, id: u.key.id, to: maskWaId(u.key.remoteJid ?? ''), status: u.update.status ?? null }, '[WA-ACK] outbound status update');
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
        if (run !== this.generation || type !== 'notify' || this.phase !== 'connected') return;
        for (const message of messages) {
          void this.handleInbound(instance, run, message);
        }
      });
    } catch (error) {
      this.setPhase('error', 'Could not create a WhatsApp session. Check server storage and retry.', String((error as Error)?.message ?? error));
      throw error;
    } finally {
      this.busy = false;
    }
  }

  /**
   * "Refresh QR Code": a new code when pairing is pending/expired. Never touches
   * a healthy connected session and never deletes credentials.
   */
  async refresh(): Promise<{ notice: 'already_connected' | 'busy' | 'refreshed' }> {
    if (this.phase === 'connected') return { notice: 'already_connected' };
    if (this.busy || this.phase === 'connecting' || this.phase === 'starting') return { notice: 'busy' };
    if (this.phase === 'scan' && this.sock) {
      // Drop the pairing socket (its close event is ignored by the generation guard) and open a new one → fresh QR.
      ++this.generation;
      const old = this.sock;
      this.sock = undefined;
      old.ev.removeAllListeners('connection.update');
      old.ev.removeAllListeners('messages.upsert');
      try { old.end(undefined); } catch { /* already closed */ }
    }
    clearTimeout(this.reconnectTimer);
    this.phase = 'idle';
    this.qrDataUrl = null;
    await this.start();
    return { notice: 'refreshed' };
  }

  /**
   * "Retry Connection": only when disconnected / reconnecting / failed. Uses the
   * normal start path (same guards, same single socket), resetting the backoff.
   */
  async retry(): Promise<{ notice: 'retrying' | 'not_needed' }> {
    if (['connected', 'connecting', 'starting', 'scan'].includes(this.phase) || this.busy) return { notice: 'not_needed' };
    clearTimeout(this.reconnectTimer);
    this.reconnectAttempts = 0;
    if (this.sock) {
      ++this.generation;
      const old = this.sock;
      this.sock = undefined;
      try { old.end(undefined); } catch { /* already closed */ }
    }
    this.phase = 'idle';
    await this.start();
    return { notice: 'retrying' };
  }

  /** Logs the linked phone out and clears THIS account's stored credentials so a different number can pair. */
  async stop(): Promise<void> {
    if (this.busy) throw new Error('Connection is changing. Try again shortly.');
    this.busy = true;
    this.stopRequested = true;
    clearTimeout(this.reconnectTimer);
    ++this.generation;
    try {
      const instance = this.sock;
      this.sock = undefined;
      if (instance) {
        try {
          await instance.logout();
        } catch {
          instance.end(undefined);
        }
      }
      fs.rmSync(this.authDir(), { recursive: true, force: true });
      clearAccountIdentity(this.accountId);
      this.reconnectAttempts = 0;
      this.setPhase('logged_out', 'Disconnected. Scan a QR code to link a phone.');
    } finally {
      this.busy = false;
    }
  }

  /** Closes the socket WITHOUT logging out (credentials kept): process shutdown or account disabled. */
  async close(reason: 'shutdown' | 'disabled' = 'shutdown'): Promise<void> {
    this.releaseAuthStoreOwnership();
    ++this.generation;
    this.stopRequested = true;
    clearTimeout(this.reconnectTimer);
    const instance = this.sock;
    this.sock = undefined;
    try { instance?.end(undefined); } catch { /* already closed */ }
    if (reason === 'disabled') this.setPhase('disconnected', 'Account disabled. Enable it to reconnect with the saved session.');
  }
}

// ------------------------------------------------------------------ manager

const connections = new Map<number, QrConnection>();

function countActiveSockets(): number {
  let n = 0;
  for (const c of connections.values()) if (c.hasSocket()) n += 1;
  return n;
}

/** The connection object for an account (created lazily; the account must exist). */
export function getConnection(accountId: number = LEGACY_ACCOUNT_ID): QrConnection {
  let connection = connections.get(accountId);
  if (!connection) {
    if (!getAccount(accountId)) throw new Error(`whatsapp account ${accountId} does not exist`);
    connection = new QrConnection(accountId);
    connections.set(accountId, connection);
  }
  return connection;
}

/** Accounts that currently have a connection object (started at least once this process). */
export function listConnections(): QrStatus[] {
  return [...connections.values()].map((c) => c.status());
}

/** Outbox sender: a row leaves ONLY through its own account's connected socket; otherwise it stays pending. */
registerOutboxSender(async (jid, text, accountId) => {
  const connection = connections.get(accountId);
  if (!connection) throw new NotConnectedError(accountId);
  return connection.send(jid, text);
});

export function getQrStatus(accountId: number = LEGACY_ACCOUNT_ID): QrStatus {
  return getConnection(accountId).status();
}

export async function startQrConnection(accountId: number = LEGACY_ACCOUNT_ID): Promise<void> {
  return getConnection(accountId).start();
}

export async function refreshQrConnection(accountId: number = LEGACY_ACCOUNT_ID): Promise<{ notice: 'already_connected' | 'busy' | 'refreshed' }> {
  return getConnection(accountId).refresh();
}

export async function retryQrConnection(accountId: number = LEGACY_ACCOUNT_ID): Promise<{ notice: 'retrying' | 'not_needed' }> {
  return getConnection(accountId).retry();
}

/** Logs the linked phone out and clears stored credentials so a different number can pair — for ONE account. */
export async function stopQrConnection(accountId: number = LEGACY_ACCOUNT_ID): Promise<void> {
  return getConnection(accountId).stop();
}

/** Closes an account's socket without logging out (credentials kept) — used when an account is disabled. */
export async function suspendQrConnection(accountId: number): Promise<void> {
  const connection = connections.get(accountId);
  if (connection) await connection.close('disabled');
}

/**
 * Permanently releases an account's connection for account DELETION: unlinks the phone when it is
 * linked (best effort — the saved credentials are removed either way), closes the socket so nothing
 * can reconnect, releases the auth-store ownership marker and forgets the connection object.
 */
export async function discardConnection(accountId: number): Promise<{ loggedOut: boolean }> {
  const connection = connections.get(accountId);
  if (!connection) return { loggedOut: false };
  let loggedOut = false;
  for (let attempt = 0; attempt < 5 && !loggedOut; attempt += 1) {
    try {
      await connection.stop();
      loggedOut = true;
    } catch (error) {
      logger.warn({ error: (error as Error).message, account: accountId, attempt }, 'connection busy while deleting the account; retrying');
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  await connection.close('shutdown');
  connections.delete(accountId);
  return { loggedOut };
}

/** Drops the account's cached knowledge base (dashboard knowledge edits apply to the next message). */
export function invalidateAccountKnowledge(accountId: number): void {
  connections.get(accountId)?.invalidateKnowledge();
}

/** Kept for existing callers: claims the legacy account's auth store. */
export function claimAuthStoreOwnership(accountId: number = LEGACY_ACCOUNT_ID): { ok: true } | { ok: false; pid: number } {
  return getConnection(accountId).claimAuthStoreOwnership();
}

/** On boot: resume every enabled QR account's saved session (or start pairing so the dashboard shows a QR). Accounts are independent. */
export function resumeQrConnection(): void {
  if (!isQrAvailable()) return;
  let accounts: WhatsappAccount[];
  try {
    accounts = listEnabledAccounts().filter((a) => a.connectionMethod === 'qr');
  } catch (error) {
    logger.error({ error }, 'could not list WhatsApp accounts at boot');
    return;
  }
  for (const account of accounts) {
    void getConnection(account.id)
      .start()
      .catch((error) => logger.warn({ error, account: account.id }, 'QR session start failed at boot'));
  }
}

/** Process shutdown: close every socket (credentials kept). */
export async function closeQrConnection(): Promise<void> {
  await Promise.all([...connections.values()].map((c) => c.close('shutdown')));
}
