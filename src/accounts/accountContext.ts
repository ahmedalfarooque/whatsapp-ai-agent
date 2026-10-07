import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Which WhatsApp account (business) the current unit of work belongs to.
 *
 * The context is set explicitly at the three places work enters the system —
 * a message arriving on an account's Baileys socket, a dashboard request for
 * the selected account, and an outbox row being delivered — and read
 * implicitly by every repository/resolver below them. Repositories also
 * accept an explicit account id for callers (and tests) that want to be
 * unambiguous; the context is the default, never the only way.
 *
 * Account 1 is the legacy single-business account every existing row was
 * migrated into (migration 015). Anything that runs outside a context — the
 * Meta Cloud API webhook path, boot-time seeding, old tests — resolves to it,
 * which is exactly the pre-multi-account behaviour.
 */
export const LEGACY_ACCOUNT_ID = 1;

const storage = new AsyncLocalStorage<number>();

export function currentAccountId(): number {
  return storage.getStore() ?? LEGACY_ACCOUNT_ID;
}

/** True only when a caller explicitly entered an account context (not the legacy default). */
export function hasAccountContext(): boolean {
  return storage.getStore() !== undefined;
}

export function runWithAccount<T>(accountId: number, fn: () => T): T {
  return storage.run(accountId, fn);
}
