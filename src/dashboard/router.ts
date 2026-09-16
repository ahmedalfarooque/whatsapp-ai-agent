import express, { Router, type Request, type Response } from 'express';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { logger } from '../logger';
import {
  getDashboardSummary,
  getServiceStatuses,
  getKnowledgeStatus,
  getRecentConversations,
  getUpcomingBookings,
  getAiConfig,
  getIntegrations,
  getSystemInfo,
  getSettingsView,
  getServicesView,
} from './data';
import { listCustomers, getCustomerById } from '../memory/customerRepo';
import { listConversations, getConversationById, getConversationMessages } from '../memory/conversationRepo';
import {
  listBookingLocks,
  reconcileUncertainAsConfirmed,
  reconcileUncertainAsNotBooked,
} from '../memory/bookingLockRepo';
import { listKnowledgeFiles, readKnowledgeFile, writeKnowledgeFile, KnowledgeFileError } from './knowledgeAdmin';
import { getProjectSyncView } from './projectSync';
import { env } from '../config/env';
import {
  adminCount,
  createAdminUser,
  verifyAdminCredentials,
  createSession,
  destroySessionByToken,
  destroyAllSessions,
} from './auth';
import {
  requireDashboardAuth,
  readSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from './authMiddleware';
import {
  OVERRIDABLE_KEYS,
  isOverridableKey,
  setSecret,
  clearSecret,
  listConfiguredOverrideKeys,
  maskSecret,
  type OverridableKey,
} from '../config/secretStore';
import { getEffectiveCredential } from '../config/effectiveConfig';
import { testConnection, getLastConnectionCheck } from './credentialTest';
import { getDb } from '../memory/db';
import {
  updateBusinessSettings,
  BusinessSettingsValidationError,
} from '../config/businessSettings';
import { getWhatsappConnectionState, markWhatsappConfigurationSaved } from '../config/whatsappConnection';
import { syncWhatsapp } from './whatsappSync';

function parsePageParams(req: Request): { limit: number; offset: number } {
  const limit = Number.parseInt(String(req.query.limit ?? '25'), 10);
  const offset = Number.parseInt(String(req.query.offset ?? '0'), 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 25,
    offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
  };
}

// Relative to the '/api/dashboard' mount point (see the router.use('/api/dashboard', ...)
// auth gate below — Express strips the mount prefix from req.path inside it).
const UNAUTHENTICATED_AUTH_ROUTES = ['/auth/status', '/auth/setup', '/auth/login'];

export function createDashboardRouter(): Router {
  const router = Router();
  const dashboardDir = path.join(__dirname, '..', '..', 'dashboard');

  router.use('/api/dashboard', express.json({ limit: '256kb' }));

  const setupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

  // ---- Auth (reachable unauthenticated, in every environment) ----------------
  router.get('/api/dashboard/auth/status', (_req, res) => {
    const hasAdmin = adminCount() > 0;
    const token = readSessionToken(_req);
    res.json({ hasAdmin, authenticated: hasAdmin && Boolean(token) });
  });

  router.post('/api/dashboard/auth/setup', setupLimiter, (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'username and password are required' });
      return;
    }
    if (username.trim().length < 3) {
      res.status(400).json({ error: 'username must be at least 3 characters' });
      return;
    }
    if (password.length < 12) {
      res.status(400).json({ error: 'password must be at least 12 characters' });
      return;
    }

    const db = getDb();
    const run = db.transaction(() => {
      if (adminCount() > 0) {
        throw Object.assign(new Error('admin already exists'), { status: 409 });
      }
      return createAdminUser(username.trim(), password);
    });

    let adminUserId: number;
    try {
      adminUserId = run();
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      if (status === 409) {
        res.status(409).json({ error: 'an admin account already exists' });
        return;
      }
      logger.error({ error }, 'dashboard: admin setup failed');
      res.status(500).json({ error: 'internal_server_error' });
      return;
    }

    const session = createSession(adminUserId);
    setSessionCookie(res, session.token, session.expiresAt);
    res.status(201).json({ ok: true });
  });

  router.post('/api/dashboard/auth/login', loginLimiter, (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'username and password are required' });
      return;
    }
    const adminUserId = verifyAdminCredentials(username, password);
    if (!adminUserId) {
      res.status(401).json({ error: 'invalid username or password' });
      return;
    }
    const session = createSession(adminUserId);
    setSessionCookie(res, session.token, session.expiresAt);
    res.json({ ok: true });
  });

  router.post('/api/dashboard/auth/logout', (req, res) => {
    const token = readSessionToken(req);
    if (token) destroySessionByToken(token);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // ---- Every other /api/dashboard/* data route requires a valid session ------
  // Deliberately scoped to the API surface only — the static SPA shell below
  // (index.html/app.js/styles.css) must stay reachable unauthenticated, since
  // the login screen itself is rendered by that same JavaScript bundle after
  // it calls /api/dashboard/auth/status.
  router.use('/api/dashboard', (req, res, next) => {
    if (UNAUTHENTICATED_AUTH_ROUTES.includes(req.path)) {
      next();
      return;
    }
    requireDashboardAuth(req, res, next);
  });

  // Revokes EVERY active session (including the caller's own) — for when an
  // admin suspects a session/device was compromised. Requires an already
  // valid session to invoke (gated above like every other route here), so
  // it can't be used to lock out an admin by an unauthenticated caller.
  router.post('/api/dashboard/auth/logout-all', (_req, res) => {
    const revoked = destroyAllSessions();
    clearSessionCookie(res);
    res.json({ ok: true, revoked });
  });

  // ---- Overview -------------------------------------------------------
  router.get('/api/dashboard/summary', (_req, res) => {
    res.json(getDashboardSummary());
  });

  router.get('/api/dashboard/status', (_req, res) => {
    res.json({
      environment: env.NODE_ENV,
      providerMode: env.shouldUseMockProviders ? 'mock' : 'production',
      services: getServiceStatuses(),
      knowledge: getKnowledgeStatus(),
    });
  });

  // ---- Customers --------------------------------------------------------
  router.get('/api/dashboard/customers', (req, res) => {
    const { limit, offset } = parsePageParams(req);
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    res.json(listCustomers({ search, limit, offset }));
  });

  router.get('/api/dashboard/customers/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid customer id' });
      return;
    }
    const customer = getCustomerById(id);
    if (!customer) {
      res.status(404).json({ error: 'customer not found' });
      return;
    }
    res.json(customer);
  });

  // ---- Conversations ------------------------------------------------------
  router.get('/api/dashboard/conversations', (req, res) => {
    const { limit, offset } = parsePageParams(req);
    const status = req.query.status === 'active' || req.query.status === 'ended' ? req.query.status : undefined;
    res.json(listConversations({ status, limit, offset }));
  });

  router.get('/api/dashboard/conversations/:id', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid conversation id' });
      return;
    }
    const conversation = getConversationById(id);
    if (!conversation) {
      res.status(404).json({ error: 'conversation not found' });
      return;
    }
    const messages = getConversationMessages(id).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      direction: m.direction,
      toolName: m.tool_name,
      createdAt: m.created_at,
    }));
    res.json({ conversation, messages });
  });

  // ---- Bookings -----------------------------------------------------------
  router.get('/api/dashboard/bookings', (req, res) => {
    const { limit, offset } = parsePageParams(req);
    const statusParam = req.query.status;
    const status =
      statusParam === 'pending' || statusParam === 'confirmed' || statusParam === 'uncertain'
        ? statusParam
        : undefined;
    res.json(listBookingLocks({ status, limit, offset }));
  });

  // Admin reconciliation for an 'uncertain' booking: the admin has manually
  // checked the real Google Calendar and is recording what they found. This
  // endpoint never calls Google itself — it only records a human's
  // out-of-band finding, so it carries none of the duplicate-creation risk
  // an automated retry would.
  router.post('/api/dashboard/bookings/:id/reconcile', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid booking id' });
      return;
    }
    const resolution = req.body?.resolution;
    if (resolution !== 'confirmed' && resolution !== 'not_booked') {
      res.status(400).json({ error: 'resolution must be "confirmed" or "not_booked"' });
      return;
    }
    if (resolution === 'confirmed') {
      const calendarEventId = req.body?.calendarEventId;
      if (typeof calendarEventId !== 'string' || calendarEventId.trim().length === 0) {
        res.status(400).json({ error: 'calendarEventId is required when resolution is "confirmed"' });
        return;
      }
      const changed = reconcileUncertainAsConfirmed(id, calendarEventId.trim());
      if (!changed) {
        res.status(409).json({ error: 'booking is not in an uncertain state (already resolved, or does not exist)' });
        return;
      }
      logger.warn(
        { bookingLockId: id, adminUserId: req.adminUserId, calendarEventId: calendarEventId.trim() },
        'admin manually reconciled an uncertain booking as CONFIRMED',
      );
      res.json({ ok: true, status: 'confirmed' });
      return;
    }
    const changed = reconcileUncertainAsNotBooked(id);
    if (!changed) {
      res.status(409).json({ error: 'booking is not in an uncertain state (already resolved, or does not exist)' });
      return;
    }
    logger.warn(
      { bookingLockId: id, adminUserId: req.adminUserId },
      'admin manually reconciled an uncertain booking as NOT BOOKED (slot released)',
    );
    res.json({ ok: true, status: 'released' });
  });

  // Kept for the dashboard home page's compact "upcoming" widget.
  router.get('/api/dashboard/bookings/upcoming', (_req, res) => {
    res.json({ bookings: getUpcomingBookings() });
  });
  router.get('/api/dashboard/conversations-recent', (_req, res) => {
    res.json({ conversations: getRecentConversations() });
  });

  // ---- Knowledge ------------------------------------------------------------
  router.get('/api/dashboard/knowledge', (_req, res) => {
    res.json({ files: listKnowledgeFiles() });
  });

  router.get('/api/dashboard/knowledge/:name', (req, res) => {
    try {
      res.json(readKnowledgeFile(req.params.name));
    } catch (error) {
      if (error instanceof KnowledgeFileError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      logger.error({ error }, 'dashboard: failed to read knowledge file');
      res.status(500).json({ error: 'internal_server_error' });
    }
  });

  router.put('/api/dashboard/knowledge/:name', (req, res) => {
    const content = req.body?.content;
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'request body must include a string "content" field' });
      return;
    }
    try {
      res.json(writeKnowledgeFile(req.params.name, content));
    } catch (error) {
      if (error instanceof KnowledgeFileError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      logger.error({ error }, 'dashboard: failed to save knowledge file');
      res.status(500).json({ error: 'internal_server_error' });
    }
  });

  // ---- Services (derived from knowledge/services.md — no second database) --
  router.get('/api/dashboard/services', (_req, res) => {
    res.json(getServicesView());
  });

  // ---- AI -------------------------------------------------------------------
  router.get('/api/dashboard/ai', (_req, res) => {
    res.json(getAiConfig());
  });

  // ---- Integrations -----------------------------------------------------------
  router.get('/api/dashboard/integrations', (_req, res) => {
    res.json({ integrations: getIntegrations() });
  });

  // ---- Credentials (encrypted dashboard override store) ----------------------
  router.get('/api/dashboard/credentials', (_req, res) => {
    const configuredOverrides = new Set(listConfiguredOverrideKeys());
    const result: Record<
      string,
      {
        source: 'override' | 'env' | 'unset';
        masked: string | null;
        lastCheckedAt: string | null;
        lastCheckOk: boolean | null;
        lastCheckDetail: string | null;
      }
    > = {};
    for (const key of OVERRIDABLE_KEYS) {
      const effective = getEffectiveCredential(key);
      const source = configuredOverrides.has(key) ? 'override' : effective ? 'env' : 'unset';
      const lastCheck = getLastConnectionCheck(key);
      result[key] = {
        source,
        masked: effective ? maskSecret(effective) : null,
        lastCheckedAt: lastCheck?.testedAt ?? null,
        lastCheckOk: lastCheck?.ok ?? null,
        lastCheckDetail: lastCheck?.detail ?? null,
      };
    }
    res.json(result);
  });

  // Real webhook connection information — the exact route Meta must call and
  // whether a verify token is currently configured (never its value). Built
  // from the incoming request's own host, so it can never drift from the
  // actual deployed URL the way a hand-typed doc value could.
  router.get('/api/dashboard/webhook-info', (req, res) => {
    const webhookUrl = `${req.protocol}://${req.get('host')}/webhook`;
    res.json({
      webhookUrl,
      verifyTokenConfigured: Boolean(getEffectiveCredential('WHATSAPP_VERIFY_TOKEN')),
      appSecretConfigured: Boolean(getEffectiveCredential('META_APP_SECRET')),
    });
  });

  // ---- WhatsApp production setup (manual config → Save → Sync) --------------
  // Single, business-facing view of the six WhatsApp fields plus the manually
  // saved webhook URL and the real, persisted connection/sync state — this is
  // what the simplified "WhatsApp Business" card in the dashboard reads.
  router.get('/api/dashboard/whatsapp/status', (req, res) => {
    const state = getWhatsappConnectionState();
    const configured = {
      wabaId: Boolean(getEffectiveCredential('WHATSAPP_BUSINESS_ACCOUNT_ID')),
      phoneNumberId: Boolean(getEffectiveCredential('WHATSAPP_PHONE_NUMBER_ID')),
      accessToken: Boolean(getEffectiveCredential('WHATSAPP_ACCESS_TOKEN')),
      verifyToken: Boolean(getEffectiveCredential('WHATSAPP_VERIFY_TOKEN')),
      appSecret: Boolean(getEffectiveCredential('META_APP_SECRET')),
      webhookUrl: Boolean(state.webhookUrl),
    };
    res.json({
      syncStatus: state.syncStatus,
      lastSyncAt: state.lastSyncAt,
      lastSyncDetail: state.lastSyncDetail,
      displayPhoneNumber: state.displayPhoneNumber,
      wabaName: state.wabaName,
      webhookUrl: state.webhookUrl,
      // The actual route Meta will reach, derived from this request — shown
      // alongside the saved value so a mismatch is obvious at a glance.
      actualWebhookRoute: `${req.protocol}://${req.get('host')}/webhook`,
      configured,
      // Non-secret configuration values, shown in full (never masked) since
      // they identify the account, not a credential.
      wabaId: getEffectiveCredential('WHATSAPP_BUSINESS_ACCOUNT_ID') || null,
      phoneNumberId: getEffectiveCredential('WHATSAPP_PHONE_NUMBER_ID') || null,
    });
  });

  router.post('/api/dashboard/whatsapp/configure', (req, res) => {
    const { wabaId, phoneNumberId, accessToken, verifyToken, appSecret, webhookUrl } = req.body ?? {};
    const fields: Record<string, string> = { wabaId, phoneNumberId, accessToken, verifyToken, appSecret, webhookUrl };
    const missing = Object.entries(fields)
      .filter(([, v]) => typeof v !== 'string' || v.trim().length === 0)
      .map(([k]) => k);
    if (missing.length > 0) {
      res.status(400).json({ error: 'validation_failed', fields: missing });
      return;
    }
    if (!/^https?:\/\/.+/i.test(webhookUrl.trim())) {
      res.status(400).json({ error: 'validation_failed', fields: ['webhookUrl'] });
      return;
    }
    // WABA ID and Phone Number ID are Meta-issued numeric identifiers, never
    // email addresses or other text — reject anything else outright, in case
    // a browser autofilled the wrong value into the form before submit.
    const numericFieldErrors = (['wabaId', 'phoneNumberId'] as const).filter((key) => !/^\d+$/.test(fields[key]!.trim()));
    if (numericFieldErrors.length > 0) {
      res.status(400).json({ error: 'validation_failed', fields: numericFieldErrors });
      return;
    }

    const adminUserId = req.adminUserId as number;
    setSecret('WHATSAPP_BUSINESS_ACCOUNT_ID', wabaId.trim(), adminUserId);
    setSecret('WHATSAPP_PHONE_NUMBER_ID', phoneNumberId.trim(), adminUserId);
    setSecret('WHATSAPP_ACCESS_TOKEN', accessToken.trim(), adminUserId);
    setSecret('WHATSAPP_VERIFY_TOKEN', verifyToken.trim(), adminUserId);
    setSecret('META_APP_SECRET', appSecret.trim(), adminUserId);
    markWhatsappConfigurationSaved(webhookUrl.trim());

    res.json({ ok: true, status: 'saved' });
  });

  // Explicit production activation step: performs a REAL Graph API
  // verification against the saved credentials. Never simulated, never
  // claims success without an actual 200 from Meta. See whatsappSync.ts.
  router.post('/api/dashboard/whatsapp/sync', async (_req, res) => {
    try {
      const result = await syncWhatsapp();
      res.json(result);
    } catch (error) {
      logger.error({ error }, 'dashboard: WhatsApp sync threw unexpectedly');
      res.status(500).json({ ok: false, detail: 'internal_server_error' });
    }
  });

  // ---- AI (OpenRouter) — simplified single-action save+test ------------------
  router.post('/api/dashboard/ai/configure', async (req, res) => {
    const apiKey = req.body?.apiKey;
    const model = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : 'openrouter/free';
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      res.status(400).json({ error: 'validation_failed', fields: ['apiKey'] });
      return;
    }
    setSecret('OPENROUTER_API_KEY', apiKey.trim(), req.adminUserId as number);
    updateBusinessSettings({ openRouterModel: model });
    try {
      const result = await testConnection('OPENROUTER_API_KEY');
      res.json(result);
    } catch (error) {
      logger.error({ error }, 'dashboard: AI configure/test threw unexpectedly');
      res.status(500).json({ ok: false, detail: 'internal_server_error' });
    }
  });

  router.put('/api/dashboard/credentials/:key', (req, res) => {
    const key = req.params.key;
    if (!isOverridableKey(key)) {
      res.status(400).json({ error: 'unknown credential key' });
      return;
    }
    const value = req.body?.value;
    if (typeof value !== 'string' || value.length === 0) {
      res.status(400).json({ error: 'request body must include a non-empty string "value" field' });
      return;
    }
    setSecret(key as OverridableKey, value, req.adminUserId as number);
    res.json({ ok: true, masked: maskSecret(value) });
  });

  router.delete('/api/dashboard/credentials/:key', (req, res) => {
    const key = req.params.key;
    if (!isOverridableKey(key)) {
      res.status(400).json({ error: 'unknown credential key' });
      return;
    }
    clearSecret(key as OverridableKey);
    res.json({ ok: true });
  });

  router.post('/api/dashboard/credentials/:key/test', async (req, res) => {
    const key = req.params.key;
    if (!isOverridableKey(key)) {
      res.status(400).json({ error: 'unknown credential key' });
      return;
    }
    try {
      const result = await testConnection(key as OverridableKey);
      res.json(result);
    } catch (error) {
      logger.error({ error, key }, 'dashboard: credential test threw unexpectedly');
      res.status(500).json({ ok: false, detail: 'internal_server_error' });
    }
  });

  // ---- System -----------------------------------------------------------------
  router.get('/api/dashboard/system', (_req, res) => {
    res.json(getSystemInfo());
  });

  // ---- Settings (business-facing config, dashboard-editable) -------------------
  router.get('/api/dashboard/settings', (_req, res) => {
    res.json(getSettingsView());
  });

  router.put('/api/dashboard/settings', (req, res) => {
    try {
      updateBusinessSettings(req.body ?? {});
      res.json(getSettingsView());
    } catch (error) {
      if (error instanceof BusinessSettingsValidationError) {
        res.status(error.status).json({ error: 'validation_failed', fields: error.fields });
        return;
      }
      logger.error({ error }, 'dashboard: failed to save settings');
      res.status(500).json({ error: 'internal_server_error' });
    }
  });

  // ---- Project Sync / AI collaboration (read-only) -----------------------------
  router.get('/api/dashboard/project-sync', (_req, res) => {
    res.json(getProjectSyncView());
  });

  // ---- Static assets + SPA shell (hash-routed, one HTML entry point) ----------
  // The exact-match route MUST come before the static middleware: express.static
  // redirects a bare directory-mount request ("/dashboard") to add a trailing
  // slash before it will serve an index file, which would break this exact URL.
  router.get('/dashboard', (_req, res) => res.sendFile(path.join(dashboardDir, 'index.html')));
  router.use('/dashboard', express.static(dashboardDir));
  router.get('/', (_req, res: Response) => res.redirect('/dashboard'));

  return router;
}
