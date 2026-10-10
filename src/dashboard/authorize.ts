import type { NextFunction, Request, Response } from 'express';
import { logger } from '../logger';
import {
  canAccessAccount,
  canManageConfiguration,
  canManageConnections,
  canManageUsers,
  featureLevel,
  getAuthUser,
  isSuperAdmin,
  levelAtLeast,
  type AuthUser,
  type FeatureKey,
  type Level,
} from './permissions';

declare module 'express-serve-static-core' {
  interface Request {
    /** The signed-in dashboard user with role and flags, loaded once per request by authorizeDashboardRequest. */
    authUser?: AuthUser;
  }
}

/**
 * What a dashboard API route needs:
 *   any            any signed-in user (the data itself is already limited to the user's own accounts)
 *   account        the user must be allowed to open the account named in the path (no feature needed)
 *   feature        a feature permission on the account (view for reads, edit for writes, manage for deletes)
 *   connection     manage WhatsApp connections / accounts (Super Admin, or an Admin explicitly granted it)
 *   configuration  sensitive configuration: credentials, providers, system, settings (same rule)
 *   users          the Users page (Super Admin or Admin)
 *   super          the permanent Super Admin only
 * Anything NOT listed below is Super-Admin-only: a route added later is closed until it is deliberately opened here.
 */
type Spec =
  | { t: 'any' }
  | { t: 'account' }
  | { t: 'feature'; feature: FeatureKey; level?: Level }
  | { t: 'connection' }
  | { t: 'configuration' }
  | { t: 'users' }
  | { t: 'super' };

interface Rule {
  test: RegExp;
  methods?: readonly string[];
  spec: Spec;
}

const F = (feature: FeatureKey, level?: Level): Spec => ({ t: 'feature', feature, level });

// Paths are relative to the /api/dashboard mount point. The first matching rule wins, so specific rules come first.
const RULES: readonly Rule[] = [
  { test: /^\/me$/, spec: { t: 'any' } },
  { test: /^\/auth\/logout$/, spec: { t: 'any' } },
  { test: /^\/accounts$/, methods: ['GET'], spec: { t: 'any' } },
  { test: /^\/accounts$/, methods: ['POST'], spec: { t: 'connection' } },
  { test: /^\/accounts\/\d+$/, methods: ['GET'], spec: { t: 'account' } },
  { test: /^\/accounts\/\d+$/, methods: ['PUT', 'DELETE'], spec: { t: 'connection' } },
  { test: /^\/accounts\/\d+\/(enable|disable)$/, spec: { t: 'connection' } },
  { test: /^\/accounts\/\d+\/qr(\/|$)/, spec: { t: 'connection' } },
  { test: /^\/accounts\/\d+\/delete-preview$/, spec: { t: 'connection' } },
  { test: /^\/accounts\/\d+\/catalogues(\/|$)/, spec: F('catalogues') },
  { test: /^\/accounts\/\d+\/setup\/files(\/|$)/, spec: F('documents') },
  { test: /^\/accounts\/\d+\/setup\/menu(\/|$)/, spec: F('menus') },
  { test: /^\/accounts\/\d+\/setup(\/|$)/, spec: F('business') },
  { test: /^\/whatsapp(\/|$)/, spec: { t: 'connection' } },
  { test: /^\/webhook-info$/, spec: { t: 'connection' } },
  { test: /^\/credentials(\/|$)/, spec: { t: 'configuration' } },
  { test: /^\/integrations$/, spec: { t: 'configuration' } },
  { test: /^\/ai\/configure$/, spec: { t: 'configuration' } },
  { test: /^\/system$/, spec: { t: 'configuration' } },
  { test: /^\/settings$/, spec: { t: 'configuration' } },
  { test: /^\/project-sync$/, spec: { t: 'configuration' } },
  { test: /^\/auth\/logout-all$/, spec: { t: 'super' } },
  { test: /^\/users(\/|$)/, spec: { t: 'users' } },
  { test: /^\/(overview|summary|status|ai-status)$/, spec: F('dashboard') },
  { test: /^\/(conversations|conversations-recent)(\/|$)/, spec: F('conversations') },
  { test: /^\/customers\/\d+\/(pause|resume)$/, spec: F('support', 'edit') },
  { test: /^\/customers(\/|$)/, spec: F('customers') },
  { test: /^\/support-queue$/, spec: F('support') },
  { test: /^\/(requests|bookings)(\/|$)/, spec: F('requests') },
  { test: /^\/notifications(\/|$)/, spec: F('notifications') },
  { test: /^\/automation\/activity$/, spec: F('activity') },
  { test: /^\/automation$/, spec: F('menus') },
  { test: /^\/templates\/[^/]+\/preview$/, spec: F('menus', 'view') },
  { test: /^\/(templates|menu-tree)(\/|$)/, spec: F('menus') },
  { test: /^\/offers(\/|$)/, spec: F('offers') },
  { test: /^\/documents(\/|$)/, spec: F('documents') },
  { test: /^\/business-profile$/, spec: F('business') },
  { test: /^\/(knowledge|services)(\/|$)/, spec: F('ai') },
  { test: /^\/ai$/, spec: F('ai') },
];

function requiredLevel(method: string, spec: Extract<Spec, { t: 'feature' }>): Level {
  if (spec.level) return spec.level;
  if (method === 'GET' || method === 'HEAD') return 'view';
  if (method === 'DELETE') return 'manage';
  return 'edit';
}

function deny(res: Response, message = 'You do not have permission to do this'): void {
  res.status(403).json({ error: message, code: 'forbidden' });
}

export function specFor(method: string, path: string): Spec {
  for (const rule of RULES) {
    if (rule.methods && !rule.methods.includes(method)) continue;
    if (rule.test.test(path)) return rule.spec;
  }
  return { t: 'super' };
}

/** The decision for one request. Exported so tests can exercise the rule table without HTTP. */
export function isAllowed(user: AuthUser, method: string, path: string, headerAccountId: number | undefined): boolean {
  const spec = specFor(method, path);
  if (isSuperAdmin(user)) return true;
  const pathAccount = /^\/accounts\/(\d+)(?:\/|$)/.exec(path);
  const accountId = pathAccount ? Number.parseInt(pathAccount[1]!, 10) : headerAccountId;
  switch (spec.t) {
    case 'any':
      return true;
    case 'super':
      return false;
    case 'users':
      return canManageUsers(user);
    case 'configuration':
      return canManageConfiguration(user);
    case 'connection':
      // A connection action on a named account also needs access to THAT account (an Admin restricted to Account 1 cannot touch Account 2).
      return canManageConnections(user) && (accountId === undefined || canAccessAccount(user, accountId));
    case 'account':
      return accountId !== undefined && canAccessAccount(user, accountId);
    case 'feature':
      return accountId !== undefined && levelAtLeast(featureLevel(user, accountId, spec.feature), requiredLevel(method, spec));
  }
}

/**
 * Runs after sign-in and after the selected account is resolved. Every dashboard API request passes through here, so the
 * browser hiding a menu item is only a convenience: a user without the permission is refused by the server (403) even when
 * they call the API directly, change the account id in a URL, or send the id in a request body.
 */
export function authorizeDashboardRequest(req: Request, res: Response, next: NextFunction): void {
  const user = req.adminUserId === undefined ? null : getAuthUser(req.adminUserId);
  if (!user || user.disabled) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  req.authUser = user;
  if (isAllowed(user, req.method, req.path, req.accountId)) {
    next();
    return;
  }
  logger.warn({ event: 'dashboard_forbidden', userId: user.id, role: user.role, method: req.method, route: req.path.replace(/\d+/g, ':n') }, 'dashboard request refused by permissions');
  deny(res);
}
