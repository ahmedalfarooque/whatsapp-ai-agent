import type Database from 'better-sqlite3';
import { getDb } from './db';
import { currentAccountId } from '../accounts/accountContext';
import {
  getAccount,
  setAccountStatus,
  recordAccountConnected,
  clearAccountIdentity,
  type AccountSessionStatus,
} from '../accounts/accountRepo';

/**
 * Linked-device session state, per WhatsApp account. Since migration 015 the
 * state lives on whatsapp_accounts; these helpers keep the original names
 * (and the legacy single-account call shape) for existing callers and tests.
 */

export type QrSessionStatus = AccountSessionStatus;

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

export function getQrSession(db: Database.Database = getDb(), accountId: number = currentAccountId()): QrSessionRecord {
  const account = getAccount(accountId, db);
  if (!account) throw new Error(`whatsapp account ${accountId} is missing — migrations did not run correctly`);
  return {
    phoneNumber: account.phoneNumber,
    jid: account.jid,
    displayName: account.displayName,
    status: account.status,
    connectedAt: account.connectedAt,
    disconnectedAt: account.disconnectedAt,
    lastError: account.lastError,
    updatedAt: account.updatedAt,
  };
}

export function setQrSessionStatus(
  status: QrSessionStatus,
  lastError: string | null = null,
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): void {
  setAccountStatus(accountId, status, lastError, db);
}

/** Records the identity that actually scanned the QR code. */
export function recordQrSessionConnected(
  identity: { phoneNumber: string | null; jid: string; displayName: string | null },
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): void {
  recordAccountConnected(accountId, identity, db);
}

/** Logout clears the identity — a different number may pair next. */
export function clearQrSessionIdentity(db: Database.Database = getDb(), accountId: number = currentAccountId()): void {
  clearAccountIdentity(accountId, db);
}
