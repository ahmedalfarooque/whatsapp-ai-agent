import type Database from 'better-sqlite3';
import { getDb } from './db';

export type QrSessionStatus =
  | 'idle'
  | 'starting'
  | 'scan'
  | 'qr_expired'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'logged_out'
  | 'error';

export interface QrSessionRecord {
  phoneNumber: string | null;
  jid: string | null;
  displayName: string | null;
  status: QrSessionStatus;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastError: string | null;
  updatedAt: string;
}

interface Row {
  phone_number: string | null;
  jid: string | null;
  display_name: string | null;
  status: string;
  connected_at: string | null;
  disconnected_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export function getQrSession(db: Database.Database = getDb()): QrSessionRecord {
  const row = db.prepare('SELECT * FROM whatsapp_qr_session WHERE id = 1').get() as Row | undefined;
  if (!row) throw new Error('whatsapp_qr_session row (id=1) is missing — migrations did not run correctly');
  return {
    phoneNumber: row.phone_number,
    jid: row.jid,
    displayName: row.display_name,
    status: row.status as QrSessionStatus,
    connectedAt: row.connected_at,
    disconnectedAt: row.disconnected_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

export function setQrSessionStatus(
  status: QrSessionStatus,
  lastError: string | null = null,
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `UPDATE whatsapp_qr_session
     SET status = @status,
         last_error = @lastError,
         disconnected_at = CASE WHEN @status IN ('disconnected','logged_out','error') THEN datetime('now') ELSE disconnected_at END,
         updated_at = datetime('now')
     WHERE id = 1`,
  ).run({ status, lastError });
}

/** Records the identity that actually scanned the QR code. */
export function recordQrSessionConnected(
  identity: { phoneNumber: string | null; jid: string; displayName: string | null },
  db: Database.Database = getDb(),
): void {
  db.prepare(
    `UPDATE whatsapp_qr_session
     SET status = 'connected', phone_number = @phoneNumber, jid = @jid, display_name = @displayName,
         connected_at = datetime('now'), last_error = NULL, updated_at = datetime('now')
     WHERE id = 1`,
  ).run(identity);
}

/** Logout clears the identity — a different number may pair next. */
export function clearQrSessionIdentity(db: Database.Database = getDb()): void {
  db.prepare(
    `UPDATE whatsapp_qr_session
     SET status = 'logged_out', phone_number = NULL, jid = NULL, display_name = NULL,
         connected_at = NULL, disconnected_at = datetime('now'), updated_at = datetime('now')
     WHERE id = 1`,
  ).run();
}
