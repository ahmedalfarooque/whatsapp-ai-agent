import type { NextFunction, Request, Response } from 'express';
import { runWithAccount } from '../accounts/accountContext';
import { getAccount, canAdminAccessAccount, defaultAccountIdForAdmin } from '../accounts/accountRepo';

/** Request header (or `?account=` query) the dashboard sends to select the business it is working on. */
export const ACCOUNT_HEADER = 'x-whatsapp-account';

/**
 * Resolves the WhatsApp account a dashboard request operates on and runs the
 * rest of the chain inside that account's context, so every repository call
 * below is scoped without each route having to say so.
 *
 * - The browser names the selected account in the X-Whatsapp-Account header.
 * - No header (old clients, curl) = the legacy account when the admin may see
 *   it, else the first account they may see — the pre-multi-account behaviour.
 * - The id is validated against the database AND the admin's permissions on
 *   the server; an unknown account is 404, a forbidden one is 403. The
 *   browser's value is never trusted on its own.
 */
export function resolveDashboardAccount(req: Request, res: Response, next: NextFunction): void {
  const adminUserId = req.adminUserId;
  if (adminUserId === undefined) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const raw = req.header(ACCOUNT_HEADER) ?? (typeof req.query.account === 'string' ? req.query.account : undefined);
  let accountId: number | null;
  if (raw !== undefined && raw.trim() !== '') {
    accountId = Number.parseInt(raw, 10);
    if (!Number.isInteger(accountId) || accountId <= 0 || !getAccount(accountId)) {
      res.status(404).json({ error: 'WhatsApp account not found' });
      return;
    }
    if (!canAdminAccessAccount(adminUserId, accountId)) {
      res.status(403).json({ error: 'You do not have access to this WhatsApp account' });
      return;
    }
  } else {
    accountId = defaultAccountIdForAdmin(adminUserId);
    if (accountId === null) {
      res.status(403).json({ error: 'No WhatsApp account is assigned to this user' });
      return;
    }
  }
  req.accountId = accountId;
  res.setHeader('X-Whatsapp-Account', String(accountId));
  runWithAccount(accountId, () => next());
}

/** For routes that name an account in the path: it must exist and the admin must be allowed to see it. */
export function assertAccountAccess(req: Request, res: Response, accountId: number): boolean {
  if (!Number.isInteger(accountId) || accountId <= 0 || !getAccount(accountId)) {
    res.status(404).json({ error: 'WhatsApp account not found' });
    return false;
  }
  if (!canAdminAccessAccount(req.adminUserId as number, accountId)) {
    res.status(403).json({ error: 'You do not have access to this WhatsApp account' });
    return false;
  }
  return true;
}
