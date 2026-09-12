import express, { Router, type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import { env } from '../config/env';
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
import { listBookingLocks } from '../memory/bookingLockRepo';
import { listKnowledgeFiles, readKnowledgeFile, writeKnowledgeFile, KnowledgeFileError } from './knowledgeAdmin';
import { getProjectSyncView } from './projectSync';

function parsePageParams(req: Request): { limit: number; offset: number } {
  const limit = Number.parseInt(String(req.query.limit ?? '25'), 10);
  const offset = Number.parseInt(String(req.query.offset ?? '0'), 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 25,
    offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
  };
}

export function createDashboardRouter(): Router {
  const router = Router();
  const dashboardDir = path.join(__dirname, '..', '..', 'dashboard');

  // The dashboard reads real application data (customer/conversation/booking
  // history, knowledge file contents) and — for knowledge editing — writes
  // to a strictly allowlisted set of files. None of this is safe to expose
  // without authentication, so until real admin auth exists, it is only
  // ever available outside production.
  const requireLocalDashboard = (_req: Request, res: Response, next: NextFunction): void => {
    if (env.isProduction) {
      res.status(404).json({ error: 'dashboard_not_available_without_admin_authentication' });
      return;
    }
    next();
  };

  router.use(requireLocalDashboard);
  router.use('/api/dashboard', express.json({ limit: '256kb' }));

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

  // ---- System -----------------------------------------------------------------
  router.get('/api/dashboard/system', (_req, res) => {
    res.json(getSystemInfo());
  });

  // ---- Settings (read-only view of server-controlled configuration) -----------
  router.get('/api/dashboard/settings', (_req, res) => {
    res.json(getSettingsView());
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
  router.get('/', (_req, res) => res.redirect('/dashboard'));

  return router;
}
