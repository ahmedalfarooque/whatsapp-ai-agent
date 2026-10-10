import type { Request, Response, Router } from 'express';
import { logger } from '../logger';
import { env } from '../config/env';
import { listAccounts } from '../accounts/accountRepo';
import {
  ASSIGNABLE_ROLES,
  FEATURES,
  LEVELS,
  accessibleAccountIds,
  canManageConfiguration,
  canManageConnections,
  canManageUsers,
  effectivePermissions,
  isSuperAdmin,
  presetPermissions,
  type AuthUser,
} from './permissions';
import { UserError, createUser, getUserView, listUsers, resetUserPassword, revokeUserSessions, setUserDisabled, updateUser, MIN_PASSWORD_LENGTH } from './users';

function fail(res: Response, error: unknown): void {
  if (error instanceof UserError) {
    res.status(error.status).json({ error: error.fields ? 'validation_failed' : error.message, message: error.message, ...(error.fields ? { fields: error.fields } : {}) });
    return;
  }
  // Never log the request body here: it can contain a password.
  logger.error({ errorName: (error as Error)?.name, errorMessage: String((error as Error)?.message ?? error).slice(0, 200) }, 'user management request failed');
  res.status(500).json({ error: 'internal_server_error' });
}

const actorId = (req: Request): number => req.adminUserId as number;
const targetId = (req: Request): number => Number.parseInt(String(req.params.id), 10);

/** What the browser needs to draw the right menu and controls. The server enforces every rule again on each request. */
export function meView(user: AuthUser, selectedAccountId: number | undefined) {
  const allowed = accessibleAccountIds(user);
  return {
    id: user.id,
    name: user.displayName,
    email: user.email ?? user.username,
    role: user.role,
    protected: user.isProtected,
    superAdmin: isSuperAdmin(user),
    allAccounts: allowed === 'all',
    accountIds: allowed === 'all' ? null : allowed,
    capabilities: {
      connection: canManageConnections(user),
      configuration: canManageConfiguration(user),
      users: canManageUsers(user),
    },
    selectedAccountId: selectedAccountId ?? null,
    permissions: selectedAccountId ? effectivePermissions(user, selectedAccountId) : {},
    // Non-secret deployment labels for the top bar (every signed-in user may see which environment they are in).
    environment: env.NODE_ENV,
    providerMode: env.shouldUseMockProviders ? 'mock' : 'production',
  };
}

export function registerUserRoutes(router: Router): void {
  router.get('/api/dashboard/me', (req, res) => {
    res.json(meView(req.authUser as AuthUser, req.accountId));
  });

  // Lookup data for the "create user" form: the accounts THIS user may hand out, the features and the roles THIS user may create.
  router.get('/api/dashboard/users/meta', (req, res) => {
    const actor = req.authUser as AuthUser;
    const allowed = accessibleAccountIds(actor);
    res.json({
      accounts: listAccounts().filter((a) => allowed === 'all' || allowed.includes(a.id)).map((a) => ({ id: a.id, name: a.name, phoneNumber: a.phoneNumber })),
      features: FEATURES,
      levels: LEVELS,
      roles: ASSIGNABLE_ROLES.filter((r) => r !== 'admin' || isSuperAdmin(actor)),
      presets: { manager: presetPermissions('manager'), user: presetPermissions('user') },
      minPasswordLength: MIN_PASSWORD_LENGTH,
      canGrantAdminCapabilities: isSuperAdmin(actor),
    });
  });

  router.get('/api/dashboard/users', (req, res) => {
    const limit = Number.parseInt(String(req.query.limit ?? '25'), 10);
    const offset = Number.parseInt(String(req.query.offset ?? '0'), 10);
    res.json(
      listUsers({
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        role: typeof req.query.role === 'string' ? req.query.role : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        limit: Number.isFinite(limit) ? limit : 25,
        offset: Number.isFinite(offset) ? offset : 0,
      }),
    );
  });

  router.get('/api/dashboard/users/:id', (req, res) => {
    const view = getUserView(targetId(req));
    if (!view) { res.status(404).json({ error: 'User not found' }); return; }
    res.json(view);
  });

  router.post('/api/dashboard/users', (req, res) => {
    try {
      const view = createUser(actorId(req), (req.body ?? {}) as Record<string, unknown>);
      logger.info({ event: 'user_created', actor: actorId(req), user: view.id, role: view.role }, 'dashboard user created');
      res.status(201).json(view);
    } catch (error) { fail(res, error); }
  });

  router.put('/api/dashboard/users/:id', (req, res) => {
    try { res.json(updateUser(actorId(req), targetId(req), (req.body ?? {}) as Record<string, unknown>)); } catch (error) { fail(res, error); }
  });

  router.post('/api/dashboard/users/:id/:action(disable|enable)', (req, res) => {
    try { res.json(setUserDisabled(actorId(req), targetId(req), req.params.action === 'disable')); } catch (error) { fail(res, error); }
  });

  router.post('/api/dashboard/users/:id/reset-password', (req, res) => {
    try {
      resetUserPassword(actorId(req), targetId(req), (req.body ?? {}).password);
      res.json({ ok: true });
    } catch (error) { fail(res, error); }
  });

  router.post('/api/dashboard/users/:id/revoke-sessions', (req, res) => {
    try { res.json({ ok: true, revoked: revokeUserSessions(actorId(req), targetId(req)) }); } catch (error) { fail(res, error); }
  });
}
