import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../memory/db';
import { logger } from '../logger';
import { getAccount, setAccountEnabled, dataDir } from './accountRepo';
import { LEGACY_ACCOUNT_ID } from './accountContext';
import { knowledgeDirForAccount } from '../knowledge/paths';
import { uploadsDir, uploadsDirFor } from '../documents/documentStore';

/**
 * Permanent deletion of one business (WhatsApp account) and everything that
 * belongs to it — and nothing else.
 *
 * Order matters and is the whole point of this module:
 *   1. refuse the protected original business and anything but an exact "DELETE";
 *   2. disable the account FIRST so nothing can (re)start its socket;
 *   3. release the Baileys connection (unlink the phone when possible, close the
 *      socket, forget the connection object) — injected so tests need no WhatsApp;
 *   4. delete every account-owned row in ONE transaction, children before parents
 *      (the schema has no ON DELETE CASCADE for the legacy tables);
 *   5. only after the commit, remove the account's files: session, uploads, knowledge.
 * Shared data (admin users/sessions, other accounts, the LID↔phone map, the
 * dedupe log of other accounts) is never touched.
 */

export class AccountDeletionError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface DeletionReport {
  accountId: number;
  name: string;
  loggedOut: boolean;
  rows: Record<string, number>;
  filesRemoved: string[];
  warnings: string[];
}

export interface DeletionDeps {
  /** Releases the account's WhatsApp connection (see discardConnection in qrConnection.ts). */
  discardConnection: (accountId: number) => Promise<{ loggedOut: boolean }>;
}

/** What the confirmation dialog tells the person before they type DELETE. */
export function describeDeletion(accountId: number): { accountId: number; name: string; counts: Record<string, number>; protected: boolean } {
  const account = getAccount(accountId);
  if (!account) throw new AccountDeletionError('WhatsApp account not found', 404, 'not_found');
  const db = getDb();
  const count = (sql: string): number => (db.prepare(sql).get(accountId) as { n: number }).n;
  return {
    accountId,
    name: account.name,
    protected: accountId === LEGACY_ACCOUNT_ID,
    counts: {
      customers: count('SELECT COUNT(*) AS n FROM customers WHERE whatsapp_account_id = ?'),
      conversations: count('SELECT COUNT(*) AS n FROM conversations WHERE whatsapp_account_id = ?'),
      messages: count('SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE whatsapp_account_id = ?)'),
      requests: count('SELECT COUNT(*) AS n FROM customer_requests WHERE whatsapp_account_id = ?'),
      documents: count('SELECT COUNT(*) AS n FROM business_documents WHERE whatsapp_account_id = ?'),
      offers: count('SELECT COUNT(*) AS n FROM offers WHERE whatsapp_account_id = ?'),
      templates: count('SELECT COUNT(*) AS n FROM reply_templates WHERE whatsapp_account_id = ?'),
      links: count('SELECT COUNT(*) AS n FROM business_links WHERE whatsapp_account_id = ?'),
    },
  };
}

function removeTree(target: string, root: string, label: string, removed: string[], warnings: string[]): void {
  const resolved = path.resolve(target);
  const base = path.resolve(root);
  // Never delete outside the tree this business owns.
  if (resolved === base || !resolved.startsWith(base + path.sep)) {
    warnings.push(`Skipped removing ${label} (outside the expected folder).`);
    return;
  }
  if (!fs.existsSync(resolved)) return;
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    removed.push(label);
  } catch (error) {
    warnings.push(`Could not remove ${path.basename(resolved)}: ${(error as Error).message}`);
  }
}

export async function deleteAccount(accountId: number, confirm: unknown, deps: DeletionDeps): Promise<DeletionReport> {
  if (!Number.isInteger(accountId) || accountId <= 0) throw new AccountDeletionError('Invalid account', 400, 'invalid');
  const account = getAccount(accountId);
  if (!account) throw new AccountDeletionError('WhatsApp account not found', 404, 'not_found');
  if (accountId === LEGACY_ACCOUNT_ID) {
    throw new AccountDeletionError('The original business account is protected and cannot be deleted. You can edit it, disable it, or disconnect its WhatsApp number instead.', 403, 'protected');
  }
  if (confirm !== 'DELETE') {
    throw new AccountDeletionError('Type DELETE to confirm that this business and all of its data should be permanently removed.', 400, 'confirmation_required');
  }

  const warnings: string[] = [];
  const db = getDb();

  // 1–2. nothing may restart this account from here on
  setAccountEnabled(accountId, false);
  let loggedOut = false;
  try {
    loggedOut = (await deps.discardConnection(accountId)).loggedOut;
  } catch (error) {
    warnings.push(`The WhatsApp connection could not be closed cleanly (${(error as Error).message}); its saved session is removed anyway.`);
    logger.warn({ error, account: accountId }, 'account deletion: connection release failed');
  }

  // Files that belong to documents of this account (including any stored by older versions in the shared folder).
  const storedFiles = (db.prepare('SELECT stored_name FROM business_documents WHERE whatsapp_account_id = ?').all(accountId) as { stored_name: string }[]).map((r) => path.basename(r.stored_name));

  // 3. database: children first, in one transaction — all or nothing
  const rows: Record<string, number> = {};
  const del = (label: string, sql: string, ...params: unknown[]): void => {
    rows[label] = db.prepare(sql).run(...params).changes;
  };
  db.transaction(() => {
    del('messages', 'DELETE FROM conversation_messages WHERE conversation_id IN (SELECT id FROM conversations WHERE whatsapp_account_id = ?)', accountId);
    del('bookingSessions', 'DELETE FROM booking_sessions WHERE conversation_id IN (SELECT id FROM conversations WHERE whatsapp_account_id = ?)', accountId);
    del('bookingLocks', 'DELETE FROM booking_locks WHERE conversation_id IN (SELECT id FROM conversations WHERE whatsapp_account_id = ?)', accountId);
    del('requestEvents', 'DELETE FROM request_events WHERE request_id IN (SELECT id FROM customer_requests WHERE whatsapp_account_id = ?)', accountId);
    del('outbox', 'DELETE FROM notification_outbox WHERE whatsapp_account_id = ?', accountId);
    del('activity', 'DELETE FROM reply_activity WHERE whatsapp_account_id = ?', accountId);
    del('requests', 'DELETE FROM customer_requests WHERE whatsapp_account_id = ?', accountId);
    del('conversations', 'DELETE FROM conversations WHERE whatsapp_account_id = ?', accountId);
    del('customers', 'DELETE FROM customers WHERE whatsapp_account_id = ?', accountId);
    del('documents', 'DELETE FROM business_documents WHERE whatsapp_account_id = ?', accountId);
    del('offers', 'DELETE FROM offers WHERE whatsapp_account_id = ?', accountId);
    del('templates', 'DELETE FROM reply_templates WHERE whatsapp_account_id = ?', accountId);
    del('links', 'DELETE FROM business_links WHERE whatsapp_account_id = ?', accountId);
    del('drafts', 'DELETE FROM setup_drafts WHERE whatsapp_account_id = ?', accountId);
    del('menus', 'DELETE FROM account_menus WHERE whatsapp_account_id = ?', accountId);
    del('adminAccess', 'DELETE FROM admin_account_access WHERE whatsapp_account_id = ?', accountId);
    del('automation', 'DELETE FROM automation_settings WHERE id = ?', accountId);
    del('profile', 'DELETE FROM business_settings WHERE id = ?', accountId);
    del('dedupe', 'DELETE FROM webhook_events WHERE message_id LIKE ?', `qr:${accountId}:%`);
    del('account', 'DELETE FROM whatsapp_accounts WHERE id = ?', accountId);
  })();

  // 4. files — only now that the rows are gone
  const filesRemoved: string[] = [];
  removeTree(path.join(dataDir(), 'accounts', String(accountId)), path.join(dataDir(), 'accounts'), `data/accounts/${accountId}/`, filesRemoved, warnings);
  removeTree(uploadsDirFor(accountId), dataDir(), `data/accounts/${accountId}/uploads/`, filesRemoved, warnings); // no-op when already inside accounts/<id>
  const legacyUploads = uploadsDir();
  for (const name of storedFiles) {
    const file = path.join(legacyUploads, name);
    if (fs.existsSync(file)) {
      try { fs.unlinkSync(file); filesRemoved.push(`uploads/${name}`); } catch (error) { warnings.push(`Could not remove ${name}: ${(error as Error).message}`); }
    }
  }
  const knowledgeRoot = path.dirname(knowledgeDirForAccount(accountId));
  removeTree(knowledgeDirForAccount(accountId), knowledgeRoot, `knowledge/accounts/${accountId}/`, filesRemoved, warnings);

  logger.info({ account: accountId, name: account.name, rows, loggedOut }, 'WhatsApp account deleted');
  return { accountId, name: account.name, loggedOut, rows, filesRemoved, warnings };
}
