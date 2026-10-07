import path from 'node:path';
import { currentAccountId, LEGACY_ACCOUNT_ID } from '../accounts/accountContext';

/** The repository's knowledge/ directory (next to dist/ and src/). */
export const KNOWLEDGE_ROOT = path.join(__dirname, '..', '..', 'knowledge');

/**
 * Where a business's knowledge files live. Account 1 (the legacy business)
 * keeps the repository's knowledge/ directory; every other account has its own
 * knowledge/accounts/<id>/ so no business ever inherits another's facts.
 */
export function knowledgeDirForAccount(accountId: number = currentAccountId()): string {
  if (!Number.isInteger(accountId) || accountId <= 0) throw new Error(`invalid whatsapp account id: ${String(accountId)}`);
  return accountId === LEGACY_ACCOUNT_ID ? KNOWLEDGE_ROOT : path.join(knowledgeAccountsRoot(), String(accountId));
}

/**
 * Parent folder of the additional businesses' knowledge. KNOWLEDGE_ACCOUNTS_DIR relocates it (the test suite points it at a
 * temporary folder so a test run can never write into the knowledge of a real business).
 */
export function knowledgeAccountsRoot(): string {
  const override = process.env.KNOWLEDGE_ACCOUNTS_DIR;
  return override && override.trim() ? path.resolve(override) : path.join(KNOWLEDGE_ROOT, 'accounts');
}
