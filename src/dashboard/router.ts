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
  checkAdminCredentials,
  diagnoseRejectedPassword,
  verifySessionToken,
  createSession,
  destroySessionByToken,
  destroyAllSessions,
  recordAdminLogin,
} from './auth';
import { OtpError, beginOtpLogin, cancelOtp, loginOtpEnabled, resendOtp, verifyOtp } from './loginOtp';
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
  getSecret,
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
import {
  getQrStatus, startQrConnection, stopQrConnection, refreshQrConnection, retryQrConnection, suspendQrConnection, invalidateAccountKnowledge, listConnections,
} from '../whatsapp/qrConnection';
import { getBusinessSettings, getBusinessSettingsOverrides, formatBusinessHours, formatAddress } from '../config/businessSettings';
import { getQrSession } from '../memory/qrSessionRepo';
import { resolveDashboardAccount, assertAccountAccess } from './accountMiddleware';
import { runWithAccount } from '../accounts/accountContext';
import {
  listAccountsForAdmin, getAccount, createAccount, updateAccount, setAccountEnabled, AccountValidationError, type WhatsappAccount,
} from '../accounts/accountRepo';
import {
  saveDocument, listDocuments, getDocument, updateDocument, replaceDocumentFile, deleteDocument, documentPath, serveContentType, extractDocumentText,
  DocumentValidationError, MAX_DOCUMENT_BYTES, ALLOWED_TYPES, type DocumentVisibility, type DocumentStatus,
} from '../documents/documentStore';
import {
  listOffers, getOffer, createOffer, updateOffer, setOfferStatus, duplicateOffer, deleteOffer, offerKpis,
  listCustomerVisibleOffers, renderOfferLine, OfferValidationError, type OfferStatus,
} from '../offers/offerRepo';
import {
  listTemplates,
  getTemplate,
  saveTemplateDraft,
  publishTemplate,
  discardTemplateDraft,
  resetTemplateToDefault,
  renderTemplateText,
  resolveTemplate,
  PREVIEW_VARS,
  templateSourceType,
  TemplateValidationError,
} from '../templates/templateRepo';
import { FOLLOW_UP_TEMPLATES, DATA_DRIVEN_FALLBACKS } from '../automation/menuRouter';
import { getMenuTables } from '../automation/menuConfig';
import { registerSetupRoutes } from './setupRoutes';
import { registerCatalogueRoutes } from './catalogueRoutes';
import {
  listCustomerRequests,
  countCustomerRequests,
  REQUEST_STATUSES,
  type CustomerRequestKind,
} from '../memory/customerRequestRepo';
import { changeRequestStatus, requestTimeline, isRequestStatus, businessNotificationJid } from '../requests/requestService';
import { listOutbox, outboxSummary, flushOutbox, retryNotification } from '../notifications/outbox';
import {
  getAutomationSettings,
  updateAutomationSettings,
  listReplyActivity,
  type ReplyActivityKind,
} from '../automation/settingsRepo';
import { listPausedCustomers, pauseCustomerAutomation, resumeCustomerAutomation } from '../memory/customerRepo';

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
const UNAUTHENTICATED_AUTH_ROUTES = ['/auth/status', '/auth/setup', '/auth/login', '/auth/otp/verify', '/auth/otp/resend', '/auth/otp/cancel'];

export function createDashboardRouter(): Router {
  const router = Router();
  const dashboardDir = path.join(__dirname, '..', '..', 'dashboard');

  router.use('/api/dashboard', express.json({ limit: '256kb' }));

  // JSON bodies so the dashboard can show a clear "too many attempts" message (a plain-text 429 used to
  // surface as a generic "Sign-in failed", indistinguishable from a wrong password).
  const tooMany = (what: string) => ({ error: `Too many ${what}. Please wait a few minutes and try again.`, code: 'rate_limited' });
  const setupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, message: tooMany('attempts') });
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: tooMany('sign-in attempts') });
  // Email-code step: a code has 1,000,000 possibilities and each challenge dies after 5 wrong
  // tries (loginOtp.ts); these per-IP caps additionally stop someone cycling many challenges.
  const otpVerifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: tooMany('verification attempts') });
  const otpResendLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 6, standardHeaders: true, legacyHeaders: false, message: tooMany('code requests') });

  const sendOtpError = (res: express.Response, error: unknown): void => {
    if (error instanceof OtpError) {
      if (error.retryAfterSec) res.setHeader('Retry-After', String(error.retryAfterSec));
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    logger.error({ error }, 'dashboard: email code step failed');
    res.status(500).json({ error: 'internal_server_error' });
  };

  // ---- Auth (reachable unauthenticated, in every environment) ----------------
  router.get('/api/dashboard/auth/status', (_req, res) => {
    const hasAdmin = adminCount() > 0;
    const token = readSessionToken(_req);
    res.json({ hasAdmin, authenticated: hasAdmin && Boolean(token && verifySessionToken(token)) });
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
    recordAdminLogin(adminUserId);
    setSessionCookie(res, session.token, session.expiresAt);
    res.status(201).json({ ok: true });
  });

  router.post('/api/dashboard/auth/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'username and password are required' });
      return;
    }
    const check = checkAdminCredentials(username, password);
    const adminUserId = check.adminUserId;
    // Diagnostics: booleans and lengths of a REJECTED attempt only. Never the username, the password, a hash,
    // a cookie or a token; a successful sign-in logs no lengths at all.
    logger.info(
      {
        event: 'dashboard_login_attempt',
        body_keys: Object.keys(req.body ?? {}),
        username_received: username.trim().length > 0,
        password_field_received: password.length > 0,
        admin_found: check.adminFound,
        password_verified: adminUserId !== null,
        session_will_be_created: adminUserId !== null && !loginOtpEnabled(),
        ...(adminUserId === null ? { username_length: username.trim().length, ...(check.adminFound ? diagnoseRejectedPassword(username, password) : {}) } : {}),
      },
      'dashboard login attempt',
    );
    if (!adminUserId) {
      res.status(401).json({ error: 'invalid username or password' });
      return;
    }
    if (loginOtpEnabled()) {
      // Password accepted, but NO session yet: the browser must present the emailed code first.
      // Any failure here (no mailer, provider down, rate limit) ends without a session — fail closed.
      try {
        const challenge = await beginOtpLogin(adminUserId);
        res.json({ ok: true, otpRequired: true, challenge: challenge.challenge, expiresAt: challenge.expiresAt, email: challenge.email });
      } catch (error) {
        sendOtpError(res, error);
      }
      return;
    }
    const session = createSession(adminUserId);
    recordAdminLogin(adminUserId);
    setSessionCookie(res, session.token, session.expiresAt);
    res.json({ ok: true });
  });

  // ---- Email one-time code (second sign-in step; see loginOtp.ts) --------------
  router.post('/api/dashboard/auth/otp/verify', otpVerifyLimiter, (req, res) => {
    const { challenge, code } = req.body ?? {};
    if (typeof challenge !== 'string' || typeof code !== 'string') {
      res.status(400).json({ error: 'challenge and code are required' });
      return;
    }
    const result = verifyOtp(challenge, code);
    if (!result.ok) {
      res.status(401).json({
        error: result.code === 'locked' ? 'Too many incorrect codes. Please sign in again.' : 'Incorrect or expired code.',
        code: result.code,
      });
      return;
    }
    const session = createSession(result.adminUserId);
    recordAdminLogin(result.adminUserId);
    setSessionCookie(res, session.token, session.expiresAt);
    res.json({ ok: true });
  });

  router.post('/api/dashboard/auth/otp/resend', otpResendLimiter, async (req, res) => {
    const { challenge } = req.body ?? {};
    if (typeof challenge !== 'string') {
      res.status(400).json({ error: 'challenge is required' });
      return;
    }
    try {
      const sent = await resendOtp(challenge);
      res.json({ ok: true, expiresAt: sent.expiresAt, email: sent.email });
    } catch (error) {
      sendOtpError(res, error);
    }
  });

  router.post('/api/dashboard/auth/otp/cancel', (req, res) => {
    cancelOtp((req.body ?? {}).challenge);
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

  // ---- Every authenticated route runs inside ONE WhatsApp account (business) ----
  // The selected account comes from the X-Whatsapp-Account header (set by the
  // dashboard's account switcher) and is validated server-side; see
  // accountMiddleware.ts. Repositories read it from the account context.
  router.use('/api/dashboard', (req, res, next) => {
    if (UNAUTHENTICATED_AUTH_ROUTES.includes(req.path)) {
      next();
      return;
    }
    resolveDashboardAccount(req, res, next);
  });

  // ---- WhatsApp accounts (businesses) ----------------------------------------
  function accountView(account: WhatsappAccount) {
    // Live phase from the running connection when there is one; otherwise the last persisted state.
    const live = listConnections().find((c) => c.accountId === account.id);
    const phase = live ? live.phase : account.status;
    return {
      id: account.id,
      name: account.name,
      nameAr: account.nameAr,
      businessCategory: account.businessCategory,
      connectionMethod: account.connectionMethod,
      enabled: account.enabled,
      phoneNumber: account.phoneNumber,
      displayName: account.displayName,
      phase,
      /** Coarse state for the sidebar: connected | connecting | qr_required | disconnected | disabled | error. */
      uiStatus: !account.enabled
        ? 'disabled'
        : phase === 'connected'
          ? 'connected'
          : ['starting', 'connecting', 'reconnecting'].includes(phase)
            ? 'connecting'
            : ['scan', 'qr_expired', 'idle', 'logged_out'].includes(phase)
              ? 'qr_required'
              : phase === 'error'
                ? 'error'
                : 'disconnected',
      connectedAt: account.connectedAt,
      disconnectedAt: account.disconnectedAt,
      lastError: account.lastError,
      isLegacy: account.id === 1,
      /** The original business cannot be deleted (it can be edited, disabled or disconnected). */
      protected: account.id === 1,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }
  function accountError(res: Response, error: unknown): void {
    if (error instanceof AccountValidationError) { res.status(error.status).json({ error: 'validation_failed', fields: error.fields }); return; }
    logger.error({ error }, 'account operation failed');
    res.status(500).json({ error: 'Account operation failed' });
  }
  router.get('/api/dashboard/accounts', (req, res) => {
    res.json({ accounts: listAccountsForAdmin(req.adminUserId as number).map(accountView), selected: req.accountId });
  });
  router.post('/api/dashboard/accounts', (req, res) => {
    try {
      const account = createAccount(req.body);
      logger.info({ account: account.id, admin: req.adminUserId }, 'dashboard: WhatsApp account created');
      res.status(201).json(accountView(account));
    } catch (error) { accountError(res, error); }
  });
  router.get('/api/dashboard/accounts/:id', (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!assertAccountAccess(req, res, id)) return;
    res.json(accountView(getAccount(id)!));
  });
  router.put('/api/dashboard/accounts/:id', (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!assertAccountAccess(req, res, id)) return;
    try { res.json(accountView(updateAccount(id, req.body)!)); } catch (error) { accountError(res, error); }
  });
  router.post('/api/dashboard/accounts/:id/:action(enable|disable)', async (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!assertAccountAccess(req, res, id)) return;
    const enable = req.params.action === 'enable';
    const account = setAccountEnabled(id, enable)!;
    // Disabling closes the socket but keeps the saved session, so enabling later resumes without a new scan.
    if (!enable) await suspendQrConnection(id);
    else if (account.connectionMethod === 'qr') await runWithAccount(id, () => startQrConnection(id)).catch((error) => logger.warn({ error, account: id }, 'could not resume the enabled account'));
    res.json(accountView(getAccount(id)!));
  });

  // ---- Business setup: information, links, PDFs/images, Analyze & Generate, menu, delete ----
  registerSetupRoutes(router, actor);
  // ---- Catalogue library: only a business that has it (every route answers 404 for any other) ----
  registerCatalogueRoutes(router, actor);

  // ---- WhatsApp linked-device (QR) connection — one per account ---------------
  async function qrAction(accountId: number, action: string): Promise<{ notice: string | null } | null> {
    let notice: string | null = null;
    if (action === 'connect') await startQrConnection(accountId);
    else if (action === 'refresh') notice = (await refreshQrConnection(accountId)).notice;
    else if (action === 'retry') notice = (await retryQrConnection(accountId)).notice;
    else if (action === 'status') notice = 'status';
    else if (action === 'disconnect') await stopQrConnection(accountId);
    else return null;
    return { notice };
  }
  const qrLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: true, legacyHeaders: false });
  // Explicit per-account endpoints (the account page uses these for any business, not only the selected one).
  router.get('/api/dashboard/accounts/:id/qr', (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!assertAccountAccess(req, res, id)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(runWithAccount(id, () => getQrStatus(id)));
  });
  router.post('/api/dashboard/accounts/:id/qr/:action', qrLimiter, async (req, res) => {
    const id = Number.parseInt(String(req.params.id), 10);
    if (!assertAccountAccess(req, res, id)) return;
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await runWithAccount(id, () => qrAction(id, String(req.params.action)));
      if (!result) { res.status(404).json({ error: 'Unknown connection action' }); return; }
      res.json({ ...runWithAccount(id, () => getQrStatus(id)), notice: result.notice });
    } catch (error) {
      logger.warn({ error, account: id }, 'QR connection action failed');
      res.status(409).json({ error: (error as Error).message || 'QR connection could not change. Use a persistent Node server and try again.' });
    }
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

  // The selected account's connection (what the WhatsApp Connection page and the header pill read).
  router.get('/api/dashboard/whatsapp/qr', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(getQrStatus(req.accountId));
  });
  router.post('/api/dashboard/whatsapp/qr/:action', qrLimiter, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await qrAction(req.accountId as number, String(req.params.action));
      if (!result) { res.status(404).json({ error: 'Unknown connection action' }); return; }
      res.json({ ...getQrStatus(req.accountId), notice: result.notice });
    } catch (error) {
      logger.warn({ error, account: req.accountId }, 'QR connection action failed');
      res.status(409).json({ error: (error as Error).message || 'QR connection could not change. Use a persistent Node server and try again.' });
    }
  });

  // ---- Business profile & location (one resolver: WhatsApp {business}/{maps}/{hours}/{address}, preview, AI) ----
  function businessProfileView(accountId: number) {
    const settings = getBusinessSettings(accountId);
    const session = getQrSession(undefined, accountId);
    return {
      accountId,
      settings,
      overrides: getBusinessSettingsOverrides(accountId),
      activeNumber: session.phoneNumber,
      activeProfileName: session.displayName,
      rendered: {
        hoursAr: formatBusinessHours(settings, 'ar'),
        hoursEn: formatBusinessHours(settings, 'en'),
        addressAr: formatAddress(settings, 'ar'),
        addressEn: formatAddress(settings, 'en'),
      },
      updatedAt: (getDb().prepare('SELECT updated_at FROM business_settings WHERE id = ?').get(accountId) as { updated_at: string } | undefined)?.updated_at ?? null,
    };
  }
  router.get('/api/dashboard/business-profile', (req, res) => {
    res.json(businessProfileView(req.accountId as number));
  });
  router.put('/api/dashboard/business-profile', (req, res) => {
    try {
      updateBusinessSettings(req.body ?? {}, req.accountId as number);
      res.json(businessProfileView(req.accountId as number));
    } catch (error) {
      if (error instanceof BusinessSettingsValidationError) { res.status(error.status).json({ error: 'validation_failed', fields: error.fields }); return; }
      logger.error({ error }, 'dashboard: failed to save business profile');
      res.status(500).json({ error: 'internal_server_error' });
    }
  });

  // ---- Business documents (uploads) -----------------------------------------
  const rawUpload = express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES + 1024 });
  function documentError(res: Response, error: unknown): void {
    if (error instanceof DocumentValidationError) { res.status(error.status).json({ error: error.message }); return; }
    if ((error as { type?: string })?.type === 'entity.too.large') { res.status(413).json({ error: `File exceeds ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB` }); return; }
    logger.error({ error }, 'document operation failed');
    res.status(500).json({ error: 'Document operation failed' });
  }
  function publicDoc(d: ReturnType<typeof getDocument>) {
    if (!d) return null;
    // stored_name / filesystem details never leave the server.
    const { stored_name: _hidden, extracted_text, ...rest } = d;
    return { ...rest, hasExtractedText: Boolean(extracted_text), fileUrl: `/api/dashboard/documents/${d.id}/file` };
  }
  router.get('/api/dashboard/documents', (req, res) => {
    const status = typeof req.query.status === 'string' && ['active', 'archived'].includes(req.query.status) ? (req.query.status as DocumentStatus) : undefined;
    res.json({ documents: listDocuments({ status }).map(publicDoc), limits: { maxBytes: MAX_DOCUMENT_BYTES, allowed: Object.keys(ALLOWED_TYPES) } });
  });
  router.post('/api/dashboard/documents', rawUpload, async (req, res) => {
    try {
      const name = decodeURIComponent(String(req.header('x-file-name') ?? 'upload'));
      const visibility = String(req.header('x-visibility') ?? 'internal') as DocumentVisibility;
      const title = req.header('x-title') ? decodeURIComponent(String(req.header('x-title'))) : null;
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const saved = saveDocument({ originalName: name, mimeType: String(req.header('content-type') ?? ''), bytes, visibility, title, uploadedBy: actor(req), purpose: req.header('x-purpose') ? decodeURIComponent(String(req.header('x-purpose'))) : null, caption: req.header('x-caption') ? decodeURIComponent(String(req.header('x-caption'))) : null });
      const doc = saved.extension === 'pdf' ? ((await extractDocumentText(saved.id)) ?? saved) : saved;
      res.status(201).json(publicDoc(doc));
    } catch (error) { documentError(res, error); }
  });
  router.get('/api/dashboard/documents/:id/file', (req, res) => {
    const doc = getDocument(Number.parseInt(req.params.id, 10));
    if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
    try {
      const filePath = documentPath(doc);
      res.setHeader('Content-Type', serveContentType(doc));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(doc.original_name)}"`);
      res.sendFile(filePath);
    } catch (error) { documentError(res, error); }
  });
  router.patch('/api/dashboard/documents/:id', (req, res) => {
    try {
      const body = (req.body ?? {}) as { title?: string | null; visibility?: DocumentVisibility; status?: DocumentStatus };
      const doc = updateDocument(Number.parseInt(req.params.id, 10), body);
      if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
      res.json(publicDoc(doc));
    } catch (error) { documentError(res, error); }
  });
  router.put('/api/dashboard/documents/:id/file', rawUpload, (req, res) => {
    try {
      const name = decodeURIComponent(String(req.header('x-file-name') ?? 'upload'));
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const doc = replaceDocumentFile(Number.parseInt(req.params.id, 10), { originalName: name, mimeType: String(req.header('content-type') ?? ''), bytes });
      if (!doc) { res.status(404).json({ error: 'Document not found' }); return; }
      res.json(publicDoc(doc));
    } catch (error) { documentError(res, error); }
  });
  router.delete('/api/dashboard/documents/:id', (req, res) => {
    if (!deleteDocument(Number.parseInt(req.params.id, 10))) { res.status(404).json({ error: 'Document not found' }); return; }
    res.json({ ok: true });
  });

  // ---- Offers & discounts -----------------------------------------------------
  function offerError(res: Response, error: unknown): void {
    if (error instanceof OfferValidationError) { res.status(error.status).json({ error: 'validation_failed', fields: error.fields }); return; }
    logger.error({ error }, 'offer operation failed');
    res.status(500).json({ error: 'Offer operation failed' });
  }
  router.get('/api/dashboard/offers', (_req, res) => {
    const offers = listOffers();
    res.json({
      offers,
      kpis: offerKpis(),
      customerVisible: listCustomerVisibleOffers().map((o) => o.id),
      preview: { ar: listCustomerVisibleOffers().map((o) => renderOfferLine(o, 'ar')), en: listCustomerVisibleOffers().map((o) => renderOfferLine(o, 'en')) },
    });
  });
  router.get('/api/dashboard/offers/:id', (req, res) => {
    const offer = getOffer(Number.parseInt(req.params.id, 10));
    if (!offer) { res.status(404).json({ error: 'Offer not found' }); return; }
    res.json({ ...offer, preview: { ar: renderOfferLine(offer, 'ar'), en: renderOfferLine(offer, 'en') } });
  });
  router.post('/api/dashboard/offers', (req, res) => {
    try { res.status(201).json(createOffer(req.body, actor(req))); } catch (error) { offerError(res, error); }
  });
  router.put('/api/dashboard/offers/:id', (req, res) => {
    try {
      const offer = updateOffer(Number.parseInt(req.params.id, 10), req.body, actor(req));
      if (!offer) { res.status(404).json({ error: 'Offer not found' }); return; }
      res.json(offer);
    } catch (error) { offerError(res, error); }
  });
  router.post('/api/dashboard/offers/:id/:action', (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      const map: Record<string, OfferStatus> = { publish: 'published', unpublish: 'draft', finish: 'finished', archive: 'archived', restore: 'draft' };
      let offer;
      if (req.params.action === 'duplicate') offer = duplicateOffer(id, actor(req));
      else if (map[req.params.action]) offer = setOfferStatus(id, map[req.params.action]!, actor(req));
      else { res.status(404).json({ error: 'Unknown offer action' }); return; }
      if (!offer) { res.status(404).json({ error: 'Offer not found' }); return; }
      res.json(offer);
    } catch (error) { offerError(res, error); }
  });
  router.delete('/api/dashboard/offers/:id', (req, res) => {
    if (!deleteOffer(Number.parseInt(req.params.id, 10), actor(req))) { res.status(404).json({ error: 'Offer not found' }); return; }
    res.json({ ok: true });
  });

  // ---- Reply templates (default / draft / live) ---------------------------
  function templateError(res: Response, error: unknown): void {
    if (error instanceof TemplateValidationError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logger.error({ error }, 'template operation failed');
    res.status(500).json({ error: 'Template operation failed' });
  }
  function actor(req: Request): string {
    const token = readSessionToken(req);
    const session = token ? verifySessionToken(token) : null;
    return session ? `admin#${session.adminUserId}` : 'admin';
  }
  router.get('/api/dashboard/templates', (_req, res) => {
    res.json({
      templates: listTemplates().map((t) => ({ ...t, sourceType: templateSourceType(t.liveAr + t.liveEn), fallbackOf: Object.entries(DATA_DRIVEN_FALLBACKS).find(([, r]) => r.fallback === t.key)?.[0] ?? null, dataFallback: DATA_DRIVEN_FALLBACKS[t.key]?.fallback ?? null })),
      followUps: FOLLOW_UP_TEMPLATES,
    });
  });
  router.get('/api/dashboard/templates/:key', (req, res) => {
    const template = getTemplate(req.params.key);
    if (!template) { res.status(404).json({ error: 'Template not found' }); return; }
    res.json(template);
  });
  // Preview = exactly what the customer would receive: the same renderer the
  // live sender uses, plus any follow-up bubble the router always sends next
  // (rendered from LIVE text, since that is what actually goes out).
  router.post('/api/dashboard/templates/:key/preview', (req, res) => {
    const body = (req.body ?? {}) as { ar?: unknown; en?: unknown };
    const followKey = FOLLOW_UP_TEMPLATES[req.params.key];
    const followUp = (lang: 'ar' | 'en') => {
      if (!followKey) return null;
      try { return { key: followKey, text: resolveTemplate(followKey, lang, PREVIEW_VARS) }; } catch { return null; }
    };
    const rule = DATA_DRIVEN_FALLBACKS[req.params.key];
    const fallbackFor = (lang: 'ar' | 'en') => {
      if (!rule) return null;
      const offers = listCustomerVisibleOffers();
      if (offers.length) return null;
      try { return { key: rule.fallback, text: resolveTemplate(rule.fallback, lang, PREVIEW_VARS), reason: 'No customer-visible offers right now — customers receive this template instead.' }; } catch { return null; }
    };
    res.json({
      ar: typeof body.ar === 'string' ? renderTemplateText(body.ar, { ...PREVIEW_VARS, language: 'ar' }) : '',
      en: typeof body.en === 'string' ? renderTemplateText(body.en, { ...PREVIEW_VARS, language: 'en' }) : '',
      followUp: { ar: followUp('ar'), en: followUp('en') },
      fallback: { ar: fallbackFor('ar'), en: fallbackFor('en') },
      sourceType: templateSourceType(`${typeof body.ar === 'string' ? body.ar : ''}${typeof body.en === 'string' ? body.en : ''}`),
      sampleVars: PREVIEW_VARS,
    });
  });
  /** The menu structure the router enforces (numbers → actions); the dashboard flow map is built from this. */
  router.get('/api/dashboard/menu-tree', (req, res) => {
    const tables = getMenuTables(req.accountId as number); // the original business: built-in structure; any other business: its own menu
    const FLOWS = tables.flows;
    res.json({ mainMenu: tables.main, submenus: tables.submenus, builtIn: tables.builtIn, flows: {
      appointment: { intro: FLOWS.appointment.intro, confirm: FLOWS.appointment.confirm, fields: FLOWS.appointment.fields, steps: FLOWS.appointment.fields.map((_, i) => (i === 0 ? FLOWS.appointment.intro : FLOWS.appointment.stepTemplate(i + 1))) },
      quotation: { intro: FLOWS.quotation.intro, confirm: FLOWS.quotation.confirm, fields: FLOWS.quotation.fields, steps: FLOWS.quotation.fields.map((_, i) => (i === 0 ? FLOWS.quotation.intro : FLOWS.quotation.stepTemplate(i + 1))) },
    }, followUps: FOLLOW_UP_TEMPLATES });
  });

  // ---- WhatsApp-collected requests (appointment / quotation) ----------------
  router.get('/api/dashboard/requests', (req, res) => {
    const kind = typeof req.query.kind === 'string' && ['appointment', 'quotation'].includes(req.query.kind) ? (req.query.kind as CustomerRequestKind) : undefined;
    const status = isRequestStatus(req.query.status) ? req.query.status : undefined;
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    const requests = listCustomerRequests({ kind, status, limit: Number.isFinite(limit) ? limit : 50 }).map((rq) => ({ ...rq, ...requestTimeline(rq.id) }));
    res.json({
      requests,
      pending: countCustomerRequests('pending'),
      statuses: REQUEST_STATUSES,
      outbox: outboxSummary(),
      staffTarget: businessNotificationJid() ? 'linked' : 'none',
    });
  });
  router.post('/api/dashboard/requests/:id/status', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const status = (req.body as { status?: unknown })?.status;
    if (!isRequestStatus(status)) {
      res.status(400).json({ error: `status must be one of: ${REQUEST_STATUSES.join(', ')}` });
      return;
    }
    const result = changeRequestStatus(id, status, { type: 'dashboard', detail: actor(req) });
    if (!result) { res.status(404).json({ error: 'Request not found' }); return; }
    res.json({ ...result.request, changed: result.changed, event: result.event, queued: result.notifications.length, ...requestTimeline(id) });
  });
  router.get('/api/dashboard/notifications', (req, res) => {
    const status = typeof req.query.status === 'string' && ['pending', 'sent', 'failed'].includes(req.query.status) ? (req.query.status as 'pending' | 'sent' | 'failed') : undefined;
    res.json({ notifications: listOutbox({ status, limit: 100 }).map((n) => ({ ...n, target_jid: n.target_jid.replace(/^(\d{0,4})\d+(?=\d{4}@)/, '$1****') })), summary: outboxSummary() });
  });
  router.post('/api/dashboard/notifications/flush', async (_req, res) => {
    const delivered = await flushOutbox();
    res.json({ delivered, summary: outboxSummary() });
  });
  router.post('/api/dashboard/notifications/:id/retry', async (req, res) => {
    if (!retryNotification(Number.parseInt(req.params.id, 10))) { res.status(404).json({ error: 'Notification not found or already sent' }); return; }
    const delivered = await flushOutbox();
    res.json({ delivered, summary: outboxSummary() });
  });
  router.post('/api/dashboard/templates/:key/draft', (req, res) => {
    try {
      const body = (req.body ?? {}) as { ar?: unknown; en?: unknown };
      res.json(saveTemplateDraft(req.params.key, { ar: body.ar, en: body.en }, actor(req)));
    } catch (error) { templateError(res, error); }
  });
  router.post('/api/dashboard/templates/:key/publish', (req, res) => {
    try {
      const body = (req.body ?? {}) as { ar?: unknown; en?: unknown };
      const explicit = typeof body.ar === 'string' || typeof body.en === 'string' ? { ar: body.ar, en: body.en } : undefined;
      res.json(publishTemplate(req.params.key, explicit, actor(req)));
    } catch (error) { templateError(res, error); }
  });
  router.post('/api/dashboard/templates/:key/discard-draft', (req, res) => {
    try { res.json(discardTemplateDraft(req.params.key)); } catch (error) { templateError(res, error); }
  });
  router.post('/api/dashboard/templates/:key/reset', (req, res) => {
    try { res.json(resetTemplateToDefault(req.params.key, actor(req))); } catch (error) { templateError(res, error); }
  });

  // ---- Automatic reply control center --------------------------------------
  router.get('/api/dashboard/automation', (req, res) => {
    const qr = getQrStatus(req.accountId);
    res.json({
      settings: getAutomationSettings(),
      connection: { phase: qr.phase, phoneNumber: qr.phoneNumber, detail: qr.detail },
      pausedCustomers: listPausedCustomers().length,
      pendingRequests: countCustomerRequests('pending'),
      templates: listTemplates().map((t) => ({ key: t.key, titleEn: t.titleEn, titleAr: t.titleAr, status: t.status, hasDraft: t.hasDraft, isModified: t.isModified })),
    });
  });
  router.patch('/api/dashboard/automation', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, boolean> = {};
    for (const key of ['autoRepliesEnabled', 'ruleRepliesEnabled', 'aiRepliesEnabled'] as const) {
      if (key in body) {
        if (typeof body[key] !== 'boolean') { res.status(400).json({ error: `${key} must be true or false` }); return; }
        patch[key] = body[key] as boolean;
      }
    }
    res.json(updateAutomationSettings(patch));
  });
  router.get('/api/dashboard/automation/activity', (req, res) => {
    const kind = typeof req.query.kind === 'string' ? (req.query.kind as ReplyActivityKind) : undefined;
    const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
    res.json({ activity: listReplyActivity({ kind, limit: Number.isFinite(limit) ? limit : 50 }) });
  });

  // ---- Human support queue --------------------------------------------------
  router.get('/api/dashboard/support-queue', (_req, res) => {
    res.json({ queue: listPausedCustomers() });
  });
  router.post('/api/dashboard/customers/:id/pause', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!getCustomerById(id)) { res.status(404).json({ error: 'Customer not found' }); return; }
    const reason = typeof (req.body as { reason?: unknown })?.reason === 'string' ? String((req.body as { reason: string }).reason).slice(0, 200) : 'Paused by staff';
    res.json(pauseCustomerAutomation(id, reason));
  });
  router.post('/api/dashboard/customers/:id/resume', (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!getCustomerById(id)) { res.status(404).json({ error: 'Customer not found' }); return; }
    res.json(resumeCustomerAutomation(id));
  });

  router.get('/api/dashboard/summary', (_req, res) => {
    res.json(getDashboardSummary());
  });

  router.get('/api/dashboard/status', (req, res) => {
    const qr = getQrStatus(req.accountId);
    res.json({
      environment: env.NODE_ENV,
      providerMode: env.shouldUseMockProviders ? 'mock' : 'production',
      accountId: req.accountId,
      services: [...getServiceStatuses(), { name: 'WhatsApp (QR)', state: qr.phase, detail: qr.detail }],
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
    // A booking belongs to a business through its conversation; another business's id is "not found".
    const owner = getDb()
      .prepare('SELECT c.whatsapp_account_id AS accountId FROM booking_locks bl JOIN conversations c ON c.id = bl.conversation_id WHERE bl.id = ?')
      .get(id) as { accountId: number } | undefined;
    if (!owner || owner.accountId !== req.accountId) {
      res.status(404).json({ error: 'booking not found' });
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
      const saved = writeKnowledgeFile(req.params.name, content);
      invalidateAccountKnowledge(req.accountId as number); // the next WhatsApp message uses the new text
      res.json(saved);
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
    // WABA ID / Phone Number ID are read directly from the dashboard's own
    // override store here — NOT via getEffectiveCredential(), which falls
    // back to raw .env. That .env value only exists to satisfy the
    // production boot check (see env.ts) and is never a real saved
    // configuration; showing it here would display a placeholder as if the
    // administrator had actually configured something.
    const savedWabaId = getSecret('WHATSAPP_BUSINESS_ACCOUNT_ID');
    const savedPhoneNumberId = getSecret('WHATSAPP_PHONE_NUMBER_ID');
    const configured = {
      wabaId: Boolean(savedWabaId),
      phoneNumberId: Boolean(savedPhoneNumberId),
      accessToken: Boolean(getSecret('WHATSAPP_ACCESS_TOKEN')),
      verifyToken: Boolean(getSecret('WHATSAPP_VERIFY_TOKEN')),
      appSecret: Boolean(getSecret('META_APP_SECRET')),
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
      wabaId: savedWabaId,
      phoneNumberId: savedPhoneNumberId,
    });
  });

  router.post('/api/dashboard/whatsapp/configure', (req, res) => {
    const { wabaId, phoneNumberId, accessToken, verifyToken, appSecret, webhookUrl } = req.body ?? {};

    // WABA ID, Phone Number ID, and Webhook URL are always required and
    // always shown in full (never masked) — the administrator re-enters or
    // confirms them on every save.
    const requiredFields: Record<string, string> = { wabaId, phoneNumberId, webhookUrl };
    const missing = Object.entries(requiredFields)
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
    const numericFieldErrors = (['wabaId', 'phoneNumberId'] as const).filter(
      (key) => !/^\d+$/.test(requiredFields[key]!.trim()),
    );
    if (numericFieldErrors.length > 0) {
      res.status(400).json({ error: 'validation_failed', fields: numericFieldErrors });
      return;
    }

    const adminUserId = req.adminUserId as number;
    setSecret('WHATSAPP_BUSINESS_ACCOUNT_ID', wabaId.trim(), adminUserId);
    setSecret('WHATSAPP_PHONE_NUMBER_ID', phoneNumberId.trim(), adminUserId);
    // Secrets are optional on every save: a blank field means "keep the
    // previously stored value", NOT "clear it" — only the dedicated Clear
    // action (DELETE /credentials/:key) removes a stored secret. This lets
    // the administrator update WABA ID/Phone Number ID/Webhook URL alone
    // without having to re-enter the Access Token/Verify Token/App Secret
    // every single time.
    if (typeof accessToken === 'string' && accessToken.trim().length > 0) {
      setSecret('WHATSAPP_ACCESS_TOKEN', accessToken.trim(), adminUserId);
    }
    if (typeof verifyToken === 'string' && verifyToken.trim().length > 0) {
      setSecret('WHATSAPP_VERIFY_TOKEN', verifyToken.trim(), adminUserId);
    }
    if (typeof appSecret === 'string' && appSecret.trim().length > 0) {
      setSecret('META_APP_SECRET', appSecret.trim(), adminUserId);
    }
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
